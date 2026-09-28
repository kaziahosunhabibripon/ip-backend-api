import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import { createHmac } from 'node:crypto';
import { eq, lt, sql } from 'drizzle-orm';
import {
  ANONYMOUS_DAILY_LOOKUP_LIMIT,
  PLAN_API_LIMITS,
  PLAN_LIMITS,
  PLAN_LOOKUP_LIMITS,
} from '../common/plans';
import { startOfNextUtcDay, startOfNextUtcMonth } from '../common/quota';
import { isProductionEnvironment } from '../config/env.config';
import type { Usage, User } from '../contracts';
import type { Database } from '../db/database';
import { monitors, usageCounters } from '../db/schema';
import { parseIPv4, parseIPv6 } from '../lookup/normalizer/ip-address';

/** One quota window for one viewer: which counter to bump, how high it may go, and when it resets. */
export interface UsageScope {
  /** `api` is the monthly request allowance for key-authenticated calls, separate from the web lookups. */
  kind: 'account' | 'anonymous' | 'api';
  key: string;
  limit: number;
  resetsAt: Date;
}

const DEV_IP_SECRET = 'ipscope-development-only-secret';

@Injectable()
export class UsageService {
  private readonly ipSecret: string;

  constructor(
    @InjectDrizzle() private readonly db: Database,
    config: ConfigService,
  ) {
    const secret = config.get<string>('IP_HASH_SECRET')?.trim();
    if (!secret && isProductionEnvironment()) {
      throw new Error(
        'IP_HASH_SECRET must be set in production — it keys the hash that identifies anonymous visitors.',
      );
    }
    this.ipSecret = secret || DEV_IP_SECRET;
  }

  scopeFor(
    user: User | null,
    ip: string | undefined,
    now = new Date(),
  ): UsageScope {
    if (user) {
      const month = now.toISOString().slice(0, 7);
      return {
        kind: 'account',
        // The counter stays keyed by the account itself — a team shares a plan, never a quota pool.
        key: `user:${user.id}:${month}`,
        limit: PLAN_LOOKUP_LIMITS[user.effectivePlan],
        resetsAt: startOfNextUtcMonth(now),
      };
    }

    const day = now.toISOString().slice(0, 10);
    return {
      kind: 'anonymous',
      key: `anon:${this.anonymousId(ip)}:${day}`,
      limit: ANONYMOUS_DAILY_LOOKUP_LIMIT,
      resetsAt: startOfNextUtcDay(now),
    };
  }

  /** The monthly API request allowance: what `POST /check` calls made with a key are counted against. */
  apiScopeFor(user: User, now = new Date()): UsageScope {
    return {
      kind: 'api',
      key: `api:${user.id}:${now.toISOString().slice(0, 7)}`,
      limit: PLAN_API_LIMITS[user.effectivePlan],
      resetsAt: startOfNextUtcMonth(now),
    };
  }

  /** Usage against the plan's limits for the current calendar month (UTC). */
  async overview(user: User, now = new Date()): Promise<Usage> {
    const periodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const periodEnd = startOfNextUtcMonth(now);
    const limits = PLAN_LIMITS[user.effectivePlan];

    const [lookups, monitorRows, apiRequests] = await Promise.all([
      this.getUsed(this.scopeFor(user, undefined, now)),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(monitors)
        .where(eq(monitors.userId, user.id)),
      this.getUsed(this.apiScopeFor(user, now)),
    ]);

    return {
      lookups: { used: lookups, limit: limits.lookups },
      apiRequests: { used: apiRequests, limit: limits.apiRequests },
      monitors: { used: monitorRows[0]?.count ?? 0, limit: limits.monitors },
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
    };
  }

  async getUsed(scope: UsageScope): Promise<number> {
    const [row] = await this.db
      .select({ count: usageCounters.count })
      .from(usageCounters)
      .where(eq(usageCounters.key, scope.key))
      .limit(1);
    return row?.count ?? 0;
  }

  /** Counts one lookup unless the window is already full. One atomic statement, so concurrent requests can't overshoot the limit. */
  async tryConsume(
    scope: UsageScope,
  ): Promise<{ allowed: boolean; used: number }> {
    if (scope.limit <= 0) {
      return { allowed: false, used: 0 };
    }

    const [row] = await this.db
      .insert(usageCounters)
      .values({ key: scope.key, count: 1 })
      .onConflictDoUpdate({
        target: usageCounters.key,
        set: { count: sql`${usageCounters.count} + 1`, updatedAt: new Date() },
        setWhere: lt(usageCounters.count, scope.limit),
      })
      .returning({ count: usageCounters.count });

    return row
      ? { allowed: true, used: row.count }
      : { allowed: false, used: await this.getUsed(scope) };
  }

  /** Gives back a lookup that produced nothing (e.g. every DNS server timed out), so a failed attempt is free. */
  async refund(scope: UsageScope): Promise<void> {
    await this.db
      .update(usageCounters)
      .set({ count: sql`greatest(${usageCounters.count} - 1, 0)` })
      .where(eq(usageCounters.key, scope.key));
  }

  /** The hashed network id of a signed-out visitor: what their daily counter is keyed by, and what an administrator can block. */
  visitorId(ip: string | undefined): string {
    return this.anonymousId(ip);
  }

  /**
   * A stable, non-reversible id for a visitor's network. IPv6 visitors are grouped by /64 — a
   * single subscriber controls a whole /64, so per-address counting would be trivial to dodge.
   */
  private anonymousId(ip: string | undefined): string {
    let basis = ip?.trim().toLowerCase() || 'unknown';
    if (basis.startsWith('::ffff:') && parseIPv4(basis.slice(7))) {
      basis = basis.slice(7); // IPv4 seen through a dual-stack socket
    }
    const groups = parseIPv4(basis) ? null : parseIPv6(basis);
    if (groups) {
      basis = groups.slice(0, 4).join(':');
    }

    return createHmac('sha256', this.ipSecret)
      .update(basis)
      .digest('hex')
      .slice(0, 32);
  }
}
