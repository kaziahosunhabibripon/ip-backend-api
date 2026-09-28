import { Injectable } from '@nestjs/common';
import { PLAN_API_LIMITS, apiRateLimit } from '../common/plans';
import { startOfNextUtcDay } from '../common/quota';
import type { ApiUsageSummary, Plan, User } from '../contracts';
import { UsageEventsService, isoDay } from './usage-events.service';
import { UsageService } from './usage.service';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The chart and the error rate look at this many days, today included. */
export const SERIES_DAYS = 30;

const startOfUtcDay = (date: Date) =>
  new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );

/**
 * The API dashboard's figures. `requestsMonth` is the exact counter quota is enforced against; the
 * per-day series and the error rate come from the request log (`lookup_events`), which is written on a
 * best-effort basis, so "today" can trail the monthly counter by a request that is still being logged.
 */
export const buildApiUsage = (input: {
  /** What the monthly allowance (and "remaining") is shown and enforced against. */
  effectivePlan: Plan;
  /**
   * What the per-minute limit follows. Deliberately the account's own plan, not `effectivePlan`: a team
   * seat is not a documented boundary — riding a team's plan raises what you're allowed to do, not how
   * fast a key may knock.
   */
  plan: Plan;
  requestsMonth: number;
  daily: { date: string; requests: number; errors: number }[];
  now: Date;
}): ApiUsageSummary => {
  const byDate = new Map(input.daily.map((row) => [row.date, row]));
  const today = startOfUtcDay(input.now).getTime();

  const series = Array.from({ length: SERIES_DAYS }, (_, index) => {
    const date = isoDay(new Date(today - (SERIES_DAYS - 1 - index) * DAY_MS));
    const row = byDate.get(date);
    return { date, requests: row?.requests ?? 0, errors: row?.errors ?? 0 };
  });

  const total = series.reduce((sum, point) => sum + point.requests, 0);
  const errors = series.reduce((sum, point) => sum + point.errors, 0);
  const monthlyLimit = PLAN_API_LIMITS[input.effectivePlan];

  return {
    requestsToday: series[series.length - 1].requests,
    requestsMonth: input.requestsMonth,
    monthlyLimit,
    remaining: Math.max(0, monthlyLimit - input.requestsMonth),
    errorRate: total === 0 ? 0 : Math.round((errors / total) * 10_000) / 10_000,
    rateLimitPerMinute: apiRateLimit(input.plan, 'production'),
    series,
  };
};

@Injectable()
export class ApiUsageService {
  constructor(
    private readonly usage: UsageService,
    private readonly events: UsageEventsService,
  ) {}

  async summary(user: User, now = new Date()): Promise<ApiUsageSummary> {
    const from = new Date(
      startOfUtcDay(now).getTime() - (SERIES_DAYS - 1) * DAY_MS,
    );
    const [requestsMonth, daily] = await Promise.all([
      this.usage.getUsed(this.usage.apiScopeFor(user, now)),
      this.events.apiDaily(user.id, from, startOfNextUtcDay(now)),
    ]);
    return buildApiUsage({
      effectivePlan: user.effectivePlan,
      plan: user.plan,
      requestsMonth,
      daily,
      now,
    });
  }
}
