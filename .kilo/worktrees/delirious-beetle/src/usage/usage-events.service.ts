import { Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';
import type {
  AnalyticsRange,
  CheckStatus,
  MetricTotal,
  ProviderKey,
  UsageAnalytics,
} from '../contracts';
import type { Database } from '../db/database';
import { historyItems, lookupEvents } from '../db/schema';

export type LookupEventStatus = CheckStatus | 'failed';
export type LatencyByProvider = Partial<Record<ProviderKey, number>>;

export interface LookupEventInput {
  status: LookupEventStatus;
  cacheHit: boolean;
  durationMs: number;
  /** Only for fresh runs — a cache hit measured nothing. */
  latency?: LatencyByProvider;
  source?: 'web' | 'api';
}

const RANGE_DAYS: Record<AnalyticsRange, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};
const DAY_MS = 24 * 60 * 60 * 1000;
const PROVIDERS: ProviderKey[] = ['dns', 'geo', 'asn', 'security'];

// ---------------------------------------------------------------- pure helpers

const startOfUtcDay = (date: Date) =>
  new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );

/** The N UTC days ending today, plus the N days before them for the "vs previous period" change. */
export const periodBounds = (range: AnalyticsRange, now: Date) => {
  const days = RANGE_DAYS[range];
  const from = new Date(startOfUtcDay(now).getTime() - (days - 1) * DAY_MS);
  return {
    days,
    from,
    previousFrom: new Date(from.getTime() - days * DAY_MS),
    to: new Date(startOfUtcDay(now).getTime() + DAY_MS),
  };
};

export const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/** Change versus the previous period as a ratio (0.12 = +12 %). With nothing before it there is nothing to compare, so 0. */
export const changeRatio = (current: number, previous: number): number =>
  previous === 0 ? 0 : (current - previous) / previous;

const metric = (current: number, previous: number): MetricTotal => ({
  value: current,
  delta: Math.round(changeRatio(current, previous) * 1000) / 1000,
});

type Aggregate = {
  successful: number;
  failed: number;
  api: number;
  cache_hits: number;
  dns: number | null;
  geo: number | null;
  asn: number | null;
  security: number | null;
};

/** Mean of the per-provider averages that have data (a provider that never answered doesn't drag it to 0). */
const meanLatency = (aggregate: Aggregate | undefined): number => {
  const values = PROVIDERS.flatMap((provider) => {
    const value = aggregate?.[provider];
    return typeof value === 'number' ? [value] : [];
  });
  return values.length
    ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
    : 0;
};

const AGGREGATES = sql`
  (count(*) filter (where source = 'web' and status <> 'failed'))::int as successful,
  (count(*) filter (where source = 'web' and status = 'failed'))::int as failed,
  (count(*) filter (where source = 'api'))::int as api,
  (count(*) filter (where source = 'web' and status <> 'failed' and cache_hit))::int as cache_hits,
  avg((latency->>'dns')::float) as dns,
  avg((latency->>'geo')::float) as geo,
  avg((latency->>'asn')::float) as asn,
  avg((latency->>'security')::float) as security`;

// Raw timestamps are stored as UTC wall-clock values, so bounds are passed as ISO text cast to `timestamp`.
const ts = (date: Date) => sql`${date.toISOString()}::timestamp`;

@Injectable()
export class UsageEventsService {
  private readonly logger = new Logger(UsageEventsService.name);

  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** Best-effort: a bookkeeping failure must never turn a good lookup into an error. */
  async record(userId: string, event: LookupEventInput): Promise<void> {
    try {
      await this.db.insert(lookupEvents).values({
        userId,
        source: event.source ?? 'web',
        status: event.status,
        cacheHit: event.cacheHit,
        durationMs: Math.max(0, Math.round(event.durationMs)),
        latency: event.latency ?? null,
      });
    } catch (error) {
      this.logger.error(
        `Could not record a lookup event: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Key-authenticated requests per UTC day in `[from, to)`, and how many of them ended in failure
   * (nothing could be read). Days with no requests are simply absent. The monthly total that quota
   * is enforced against lives in `usage_counters`, because events are best-effort bookkeeping.
   */
  async apiDaily(
    userId: string,
    from: Date,
    to: Date,
  ): Promise<{ date: string; requests: number; errors: number }[]> {
    const result = await this.db.execute<{
      date: string;
      requests: number;
      errors: number;
    }>(sql`
      select to_char(at, 'YYYY-MM-DD') as date,
             count(*)::int as requests,
             (count(*) filter (where status = 'failed'))::int as errors
      from lookup_events
      where user_id = ${userId} and source = 'api' and at >= ${ts(from)} and at < ${ts(to)}
      group by 1 order by 1`);
    return result.rows;
  }

  async analytics(
    userId: string,
    range: AnalyticsRange,
    now = new Date(),
  ): Promise<UsageAnalytics> {
    const { days, from, previousFrom, to } = periodBounds(range, now);

    const [totals, perDay, topTargets] = await Promise.all([
      this.db.execute<Aggregate & { period: 'current' | 'previous' }>(sql`
        select case when at >= ${ts(from)} then 'current' else 'previous' end as period, ${AGGREGATES}
        from lookup_events
        where user_id = ${userId} and at >= ${ts(previousFrom)} and at < ${ts(to)}
        group by 1`),
      this.db.execute<Aggregate & { day: string }>(sql`
        select to_char(at, 'YYYY-MM-DD') as day, ${AGGREGATES}
        from lookup_events
        where user_id = ${userId} and at >= ${ts(from)} and at < ${ts(to)}
        group by 1`),
      this.db
        .select({
          target: historyItems.target,
          checks: sql<number>`count(*)::int`,
        })
        .from(historyItems)
        .where(
          and(
            eq(historyItems.userId, userId),
            gte(historyItems.checkedAt, from),
          ),
        )
        .groupBy(historyItems.target)
        .orderBy(desc(sql`count(*)`), asc(historyItems.target))
        .limit(5),
    ]);

    const current = totals.rows.find((row) => row.period === 'current');
    const previous = totals.rows.find((row) => row.period === 'previous');
    const checksOf = (row?: Aggregate) =>
      (row?.successful ?? 0) + (row?.failed ?? 0);
    const hitRateOf = (row?: Aggregate) =>
      row && row.successful > 0 ? row.cache_hits / row.successful : 0;

    const byDay = new Map(perDay.rows.map((row) => [row.day, row]));
    const dates = Array.from({ length: days }, (_, index) =>
      isoDay(new Date(from.getTime() + index * DAY_MS)),
    );

    return {
      range,
      totals: {
        totalChecks: metric(checksOf(current), checksOf(previous)),
        successfulChecks: metric(
          current?.successful ?? 0,
          previous?.successful ?? 0,
        ),
        failedChecks: metric(current?.failed ?? 0, previous?.failed ?? 0),
        apiRequests: metric(current?.api ?? 0, previous?.api ?? 0),
        cacheHitRate: metric(
          Math.round(hitRateOf(current) * 1000) / 1000,
          Math.round(hitRateOf(previous) * 1000) / 1000,
        ),
        providerLatencyMs: metric(meanLatency(current), meanLatency(previous)),
      },
      checks: dates.map((date) => ({
        date,
        successful: byDay.get(date)?.successful ?? 0,
        failed: byDay.get(date)?.failed ?? 0,
      })),
      latency: dates.map((date) => {
        const row = byDay.get(date);
        return {
          date,
          dns: Math.round(row?.dns ?? 0),
          geo: Math.round(row?.geo ?? 0),
          asn: Math.round(row?.asn ?? 0),
          security: Math.round(row?.security ?? 0),
        };
      }),
      topTargets: topTargets.map((row) => ({
        target: row.target,
        checks: row.checks,
      })),
    };
  }
}
