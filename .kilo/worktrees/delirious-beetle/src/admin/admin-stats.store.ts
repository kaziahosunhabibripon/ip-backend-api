import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { sql } from 'drizzle-orm';
import { PLAN_ORDER } from '../common/plans';
import { canAccess } from '../common/features';
import type { Plan } from '../contracts';
import { isPaidPlan, unitAmountCents } from '../billing/plan-catalog';
import type { Database } from '../db/database';

/** Type aliases, not interfaces: raw query rows must be assignable to `Record<string, unknown>`. */
export type DayCount = { day: string; count: number };

export type SourceDayCount = DayCount & { source: string };

export interface SubscriptionEventRow {
  id: string;
  email: string;
  kind: string;
  plan: Plan;
  amountCents: number;
  at: Date;
}

/** Bounds are passed as ISO text cast to `timestamp`: columns hold UTC wall-clock time, and this keeps the machine's own zone out of it. */
const ts = (date: Date) => sql`${date.toISOString()}::timestamp`;

/**
 * The aggregate queries behind the admin overview. Plain SQL, because every one of them is a count or a sum over a
 * table that already has the columns it needs; `AdminOverviewService` decides what the numbers mean.
 */
@Injectable()
export class AdminStatsStore {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  async userCounts(
    since: Date,
  ): Promise<{ total: number; createdSince: number; premium: number }> {
    const { rows } = await this.db.execute<{
      total: number;
      created_since: number;
      premium: number;
    }>(sql`
      select count(*)::int as total,
             count(*) filter (where created_at >= ${ts(since)})::int as created_since,
             count(*) filter (where plan <> 'free')::int as premium
      from users`);
    const row = rows[0];
    return {
      total: row.total,
      createdSince: row.created_since,
      premium: row.premium,
    };
  }

  async planCounts(): Promise<Record<Plan, number>> {
    const { rows } = await this.db.execute<{ plan: Plan; count: number }>(
      sql`select plan, count(*)::int as count from users group by plan`,
    );
    const counts = Object.fromEntries(
      PLAN_ORDER.map((plan) => [plan, 0]),
    ) as Record<Plan, number>;
    for (const row of rows) {
      counts[row.plan] = row.count;
    }
    return counts;
  }

  /** Signed-in users who looked something up in [from, to). */
  async activeUsers(from: Date, to: Date): Promise<number> {
    const { rows } = await this.db.execute<{ count: number }>(sql`
      select count(distinct user_id)::int as count
      from lookup_events
      where at >= ${ts(from)} and at < ${ts(to)}`);
    return rows[0].count;
  }

  /** Lookups by UTC day and source ('web' or 'api') from `since` on. Failures and cache hits count: it is what people asked for. */
  async eventsByDay(since: Date): Promise<SourceDayCount[]> {
    const { rows } = await this.db.execute<{
      day: string;
      source: string;
      count: number;
    }>(sql`
      select to_char(date_trunc('day', at), 'YYYY-MM-DD') as day, source, count(*)::int as count
      from lookup_events
      where at >= ${ts(since)}
      group by 1, 2`);
    return rows;
  }

  /**
   * Signed-out lookups by UTC day, from the daily counters (`anon:<hash>:<YYYY-MM-DD>`). They count lookups that
   * used quota, so a repeat served from the cache is not in them — signed-out visitors have no event log.
   */
  async anonymousByDay(sinceDay: string): Promise<DayCount[]> {
    const { rows } = await this.db.execute<DayCount>(sql`
      select right(key, 10) as day, sum(count)::int as count
      from usage_counters
      where key like 'anon:%' and right(key, 10) >= ${sinceDay}
      group by 1`);
    return rows;
  }

  async apiRequests(from: Date, to: Date): Promise<number> {
    const { rows } = await this.db.execute<{ count: number }>(sql`
      select count(*)::int as count from lookup_events
      where source = 'api' and at >= ${ts(from)} and at < ${ts(to)}`);
    return rows[0].count;
  }

  /** Lookups that came back with nothing at all: every provider down, DNS timing out. */
  async failedLookups(from: Date, to: Date): Promise<number> {
    const { rows } = await this.db.execute<{ count: number }>(sql`
      select count(*)::int as count from lookup_events
      where status = 'failed' and at >= ${ts(from)} and at < ${ts(to)}`);
    return rows[0].count;
  }

  /**
   * What the paid plans running right now are worth a month, in cents (annual periods divided by twelve). Plans are
   * prepaid, not recurring, so this is the monthly value of what is currently paid for. Each plan is counted at its
   * price for one period: what a row has *paid* can be several periods (renewals stack), which would overstate it.
   * A hand-arranged Enterprise plan has no payment here and is not counted.
   */
  async monthlyRecurringCents(now: Date): Promise<number> {
    const { rows } = await this.db.execute<{
      plan: Plan;
      billing_cycle: string;
      count: number;
    }>(sql`
      select plan, billing_cycle, count(*)::int as count
      from subscriptions
      where plan <> 'free'
        and status = 'active'
        and current_period_end > ${ts(now)}
      group by plan, billing_cycle`);

    return Math.round(
      rows.reduce((total, row) => {
        if (!isPaidPlan(row.plan)) {
          return total;
        }
        const cycle = row.billing_cycle === 'annual' ? 'annual' : 'monthly';
        const price = unitAmountCents(row.plan, cycle);
        return total + (row.count * price) / (cycle === 'annual' ? 12 : 1);
      }, 0),
    );
  }

  /** Movement in paying customers since `since`, to work out how many there were then. */
  async premiumMovement(
    since: Date,
  ): Promise<{ joined: number; left: number }> {
    const { rows } = await this.db.execute<{ joined: number; left: number }>(
      sql`
      select count(*) filter (where kind = 'upgraded' and from_plan = 'free')::int as joined,
             count(*) filter (where kind = 'canceled')::int as left
      from subscription_events
      where at >= ${ts(since)}`,
    );
    return { joined: rows[0].joined, left: rows[0].left };
  }

  async recentSubscriptionEvents(
    limit: number,
  ): Promise<SubscriptionEventRow[]> {
    const { rows } = await this.db.execute<{
      id: string;
      email: string;
      kind: string;
      plan: Plan;
      amount_cents: number;
      at: string;
    }>(sql`
      select e.id, u.email, e.kind, e.plan, e.amount_cents, e.at::text as at
      from subscription_events e
      join users u on u.id = e.user_id
      order by e.at desc, e.id
      limit ${limit}`);
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      kind: row.kind,
      plan: row.plan,
      amountCents: row.amount_cents,
      at: new Date(`${row.at.replace(' ', 'T')}Z`),
    }));
  }

  /** How the database answers, and how full its connection slots are. */
  async databaseStatus(): Promise<{
    latencyMs: number;
    connections: number;
    maxConnections: number;
  }> {
    const started = Date.now();
    const { rows } = await this.db.execute<{
      connections: number;
      max_connections: number;
    }>(sql`
      select (select count(*)::int from pg_stat_activity where datname = current_database()) as connections,
             current_setting('max_connections')::int as max_connections`);
    return {
      latencyMs: Date.now() - started,
      connections: rows[0].connections,
      maxConnections: rows[0].max_connections,
    };
  }

  /**
   * Monitors that should be running: enabled, on a plan that includes monitoring, and not suspended. `overdue`
   * are those more than `graceMinutes` past their next check — the scheduler is behind or off everywhere.
   */
  async monitorStatus(
    now: Date,
    graceMinutes: number,
  ): Promise<{ running: number; overdue: number; failing: number }> {
    const plans = PLAN_ORDER.filter((plan) => canAccess(plan, 'monitoring'));
    const late = new Date(now.getTime() - graceMinutes * 60_000);
    const { rows } = await this.db.execute<{
      running: number;
      overdue: number;
      failing: number;
    }>(sql`
      select count(*)::int as running,
             count(*) filter (where m.next_check_at < ${ts(late)})::int as overdue,
             count(*) filter (where m.status = 'failing')::int as failing
      from monitors m
      join users u on u.id = m.user_id
      where m.enabled
        and u.suspended_at is null
        and u.plan in (${sql.join(
          plans.map((plan) => sql`${plan}`),
          sql`, `,
        )})`);
    return rows[0];
  }
}
