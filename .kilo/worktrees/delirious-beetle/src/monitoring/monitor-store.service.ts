import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  sql,
  type InferSelectModel,
} from 'drizzle-orm';
import type { InputType, MonitorWatch } from '../contracts';
import type { Database } from '../db/database';
import { isUniqueViolation } from '../db/errors';
import { monitors, users } from '../db/schema';
import type { MonitorSnapshot } from './snapshot';

export type MonitorRow = InferSelectModel<typeof monitors>;

export interface NewMonitor {
  target: string;
  targetType: InputType;
  intervalMinutes: number;
  watch: MonitorWatch[];
}

export type CreateOutcome =
  | { status: 'created'; monitor: MonitorRow }
  | { status: 'limit' }
  | { status: 'exists' };

/** What one run leaves behind. */
export interface RunRecord {
  /** Only set when the run got a good look; a failed run keeps the old baseline. */
  snapshot?: MonitorSnapshot;
  status: 'healthy' | 'failing';
  consecutiveFailures: number;
  lastCheckedAt: Date;
  /** Used unless the monitor was paused while the run was in flight. */
  nextCheckAt: Date;
}

/** Database access for monitors. The rules about what a run means live in `MonitorRunner`. */
@Injectable()
export class MonitorStore {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  list(userId: string): Promise<MonitorRow[]> {
    return this.db
      .select()
      .from(monitors)
      .where(eq(monitors.userId, userId))
      .orderBy(desc(monitors.createdAt), asc(monitors.id));
  }

  /** Scoped to `userId`: someone else's monitor id is indistinguishable from a missing one. */
  async find(userId: string, id: string): Promise<MonitorRow | undefined> {
    const [row] = await this.db
      .select()
      .from(monitors)
      .where(and(eq(monitors.id, id), eq(monitors.userId, userId)))
      .limit(1);
    return row;
  }

  async get(id: string): Promise<MonitorRow | undefined> {
    const [row] = await this.db
      .select()
      .from(monitors)
      .where(eq(monitors.id, id))
      .limit(1);
    return row;
  }

  /**
   * Counts and inserts under a per-user advisory lock, so two simultaneous requests can't both slip under
   * the plan's limit. The new monitor is due immediately: its first run is the baseline.
   */
  async create(
    userId: string,
    input: NewMonitor,
    limit: number | null,
    now: Date,
  ): Promise<CreateOutcome> {
    try {
      return await this.db.transaction(async (tx): Promise<CreateOutcome> => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${userId}))`,
        );

        const existing = await tx
          .select({ id: monitors.id, target: monitors.target })
          .from(monitors)
          .where(eq(monitors.userId, userId));
        if (existing.some((row) => row.target === input.target)) {
          return { status: 'exists' };
        }
        if (limit !== null && existing.length >= limit) {
          return { status: 'limit' };
        }

        const [monitor] = await tx
          .insert(monitors)
          .values({
            userId,
            ...input,
            enabled: true,
            status: 'healthy',
            nextCheckAt: now,
            createdAt: now,
          })
          .returning();
        return { status: 'created', monitor };
      });
    } catch (error) {
      // The unique index is the backstop behind the check above.
      if (isUniqueViolation(error)) {
        return { status: 'exists' };
      }
      throw error;
    }
  }

  /**
   * Pausing clears the schedule. Resuming makes it due now and forgets earlier failures, but keeps the
   * baseline, so a change that happened while it was paused is still reported.
   */
  async setEnabled(
    userId: string,
    id: string,
    enabled: boolean,
    now: Date,
  ): Promise<MonitorRow | undefined> {
    const [row] = await this.db
      .update(monitors)
      .set(
        enabled
          ? {
              enabled: true,
              status: 'healthy',
              consecutiveFailures: 0,
              nextCheckAt: now,
            }
          : { enabled: false, nextCheckAt: null },
      )
      .where(and(eq(monitors.id, id), eq(monitors.userId, userId)))
      .returning();
    return row;
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const removed = await this.db
      .delete(monitors)
      .where(and(eq(monitors.id, id), eq(monitors.userId, userId)))
      .returning({ id: monitors.id });
    return removed.length > 0;
  }

  /**
   * Takes the monitors that are due and leases them: their next run is pushed `leaseMs` ahead in the same
   * transaction, and `SKIP LOCKED` means two API instances never take the same one. If the instance dies
   * mid-run the lease simply runs out and another one picks the monitor up. Only monitors whose owner's
   * plan still includes monitoring are taken (a downgrade stops the runs without deleting anything) — but
   * that check needs a live look at team membership too, so it happens in `MonitorRunner` right before a
   * claimed monitor actually runs, not here in the claim's SQL.
   */
  claimDue(now: Date, batch: number, leaseMs: number): Promise<MonitorRow[]> {
    return this.db.transaction(async (tx) => {
      const due = await tx
        .select({ monitor: monitors })
        .from(monitors)
        .innerJoin(users, eq(users.id, monitors.userId))
        .where(
          and(
            eq(monitors.enabled, true),
            lte(monitors.nextCheckAt, now),
            // A suspended account's monitors stop running (and emailing) along with everything else.
            isNull(users.suspendedAt),
          ),
        )
        .orderBy(asc(monitors.nextCheckAt), asc(monitors.id))
        .limit(batch)
        .for('update', { of: monitors, skipLocked: true });

      if (due.length > 0) {
        await tx
          .update(monitors)
          .set({ nextCheckAt: new Date(now.getTime() + leaseMs) })
          .where(
            inArray(
              monitors.id,
              due.map((row) => row.monitor.id),
            ),
          );
      }
      return due.map((row) => row.monitor);
    });
  }

  /**
   * Pushes a claimed monitor's next check out without recording a run: the owner's plan (their own, or a
   * team's) doesn't currently include monitoring, so there is nothing to check yet. Leaves `status`,
   * `consecutiveFailures` and `lastCheckedAt` alone, so this never looks like — or counts toward — a failure.
   */
  async postpone(id: string, nextCheckAt: Date): Promise<void> {
    await this.db
      .update(monitors)
      .set({ nextCheckAt })
      .where(eq(monitors.id, id));
  }

  /** Returns false when the monitor was deleted while the run was in flight. */
  async recordRun(id: string, record: RunRecord): Promise<boolean> {
    const next = record.nextCheckAt.toISOString();
    const updated = await this.db
      .update(monitors)
      .set({
        status: record.status,
        consecutiveFailures: record.consecutiveFailures,
        lastCheckedAt: record.lastCheckedAt,
        // A monitor paused mid-run must stay unscheduled.
        nextCheckAt: sql`case when ${monitors.enabled} then ${next}::timestamp else null end`,
        ...(record.snapshot ? { lastResult: record.snapshot } : {}),
      })
      .where(eq(monitors.id, id))
      .returning({ id: monitors.id });
    return updated.length > 0;
  }

  async markEmailed(id: string, at: Date): Promise<void> {
    await this.db
      .update(monitors)
      .set({ lastEmailedAt: at })
      .where(eq(monitors.id, id));
  }
}
