import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import { sql } from 'drizzle-orm';
import type { Database } from '../db/database';
import { RetentionDays, readRetention, retentionCutoffs } from './retention';

/** Rows deleted per statement, so a first run over a big backlog never holds a table lock for long. */
export const BATCH_SIZE = 5_000;

export type PruneReport = Record<
  | 'sessions'
  | 'authTokens'
  | 'lookupEvents'
  | 'anonymousCounters'
  | 'monthlyCounters'
  | 'alerts'
  | 'bulkJobs',
  number
>;

interface Target {
  table: string;
  key: string;
  time: string;
  before: Date;
  /** A fixed condition written in this file, never input. */
  extra?: string;
}

/**
 * Deletes bookkeeping that nothing can show any more. It never touches what a customer owns or what
 * money depends on: saved checks, monitors, API keys, subscriptions, payments and the audit log stay.
 */
@Injectable()
export class MaintenanceService {
  private readonly days: RetentionDays;

  constructor(
    @InjectDrizzle() private readonly db: Database,
    config: ConfigService,
  ) {
    this.days = readRetention({
      LOOKUP_EVENT_RETENTION_DAYS: config.get<string>(
        'LOOKUP_EVENT_RETENTION_DAYS',
      ),
      ALERT_RETENTION_DAYS: config.get<string>('ALERT_RETENTION_DAYS'),
      BULK_RETENTION_DAYS: config.get<string>('BULK_RETENTION_DAYS'),
    });
  }

  async prune(now = new Date()): Promise<PruneReport> {
    const cutoff = retentionCutoffs(now, this.days);
    const expired = cutoff.expiredCredentials;
    return {
      sessions: await this.deleteOld({
        table: 'sessions',
        key: 'id',
        time: 'expires_at',
        before: expired,
      }),
      authTokens: await this.deleteOld({
        table: 'auth_tokens',
        key: 'id',
        time: 'expires_at',
        before: expired,
      }),
      lookupEvents: await this.deleteOld({
        table: 'lookup_events',
        key: 'id',
        time: 'at',
        before: cutoff.lookupEvents,
      }),
      anonymousCounters: await this.deleteOld({
        table: 'usage_counters',
        key: 'key',
        time: 'updated_at',
        before: cutoff.anonymousCounters,
        extra: `key like 'anon:%'`,
      }),
      monthlyCounters: await this.deleteOld({
        table: 'usage_counters',
        key: 'key',
        time: 'updated_at',
        before: cutoff.monthlyCounters,
        extra: `key not like 'anon:%'`,
      }),
      alerts: await this.deleteOld({
        table: 'alerts',
        key: 'id',
        time: 'created_at',
        before: cutoff.alerts,
      }),
      // The lines go with their job (ON DELETE CASCADE).
      bulkJobs: await this.deleteOld({
        table: 'bulk_jobs',
        key: 'id',
        time: 'created_at',
        before: cutoff.bulkJobs,
      }),
    };
  }

  /**
   * The identifiers and `extra` are fixed strings from `prune`, which is why they may be spliced in; the cutoff
   * travels as a bound parameter (as ISO text, so the session time zone cannot shift it). The `limit` sits in a
   * subselect because Postgres has no `delete … limit`.
   */
  private async deleteOld(target: Target): Promise<number> {
    const table = sql.identifier(target.table);
    const key = sql.identifier(target.key);
    const time = sql.identifier(target.time);
    const extra = target.extra ? sql` and ${sql.raw(target.extra)}` : sql``;

    let total = 0;
    for (;;) {
      const result = await this.db.execute(sql`
        delete from ${table}
        where ${key} in (
          select ${key} from ${table}
          where ${time} < ${target.before.toISOString()}::timestamp${extra}
          limit ${BATCH_SIZE}
        )`);
      const deleted = result.rowCount ?? 0;
      total += deleted;
      if (deleted < BATCH_SIZE) return total;
    }
  }
}
