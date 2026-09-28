import { Injectable } from '@nestjs/common';
import {
  describeReason,
  isAbuseReason,
  type AbuseKind,
} from '../abuse/abuse-rules';
import { AbuseStore, type AbuseFlagRow } from '../abuse/abuse-store.service';
import { PLAN_ORDER } from '../common/plans';
import type {
  AbuseFlag,
  AdminOverview,
  MetricTotal,
  SubscriptionEvent,
} from '../contracts';
import { AdminStatsStore } from './admin-stats.store';
import { AdminSystemService } from './admin-system.service';
import { AdminUsersService } from './admin-users.service';

const DAY_MS = 24 * 60 * 60_000;
const SERIES_DAYS = 30;
const USERS_SHOWN = 100;
const EVENTS_SHOWN = 20;
const FLAGS_SHOWN = 50;

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const startOfUtcDay = (date: Date) =>
  new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );

/** Change against the previous period as a ratio (0.12 = +12%). No baseline means no meaningful ratio, so 0. */
export const changeSince = (now: number, previous: number): number =>
  previous <= 0
    ? 0
    : Math.round(((now - previous) / previous) * 10_000) / 10_000;

const metric = (value: number, previous: number): MetricTotal => ({
  value,
  delta: changeSince(value, previous),
});

export const toAbuseFlag = (row: AbuseFlagRow): AbuseFlag => ({
  id: row.id,
  subject: row.subjectLabel,
  kind: row.kind as AbuseKind,
  reason: isAbuseReason(row.reason)
    ? describeReason(row.reason, row.events)
    : row.reason,
  severity: row.severity as AbuseFlag['severity'],
  events: row.events,
  lastSeenAt: row.lastSeenAt.toISOString(),
  status: row.status as AbuseFlag['status'],
});

/**
 * Builds the admin dashboard from what is actually in the database and in this process. What each figure
 * means is spelled out on the API docs for `GET /admin/overview`; two things worth knowing here:
 *
 * - "checks" are lookups people asked for — cache hits and failures included — except for signed-out visitors,
 *   who have no event log: theirs are counted from the daily quota counters and so exclude cache hits.
 * - deltas compare with the period before, and a figure with nothing to compare with reports 0, not a made-up trend.
 */
@Injectable()
export class AdminOverviewService {
  constructor(
    private readonly stats: AdminStatsStore,
    private readonly users: AdminUsersService,
    private readonly system: AdminSystemService,
    private readonly abuse: AbuseStore,
  ) {}

  async build(now = new Date()): Promise<AdminOverview> {
    const today = startOfUtcDay(now);
    const seriesStart = new Date(today.getTime() - (SERIES_DAYS - 1) * DAY_MS);
    const d30 = new Date(now.getTime() - 30 * DAY_MS);
    const d60 = new Date(now.getTime() - 60 * DAY_MS);
    const h24 = new Date(now.getTime() - DAY_MS);
    const h48 = new Date(now.getTime() - 2 * DAY_MS);

    const [
      counts,
      plans,
      active,
      activeBefore,
      movement,
      byDay,
      anonymousByDay,
      api,
      apiBefore,
      failed,
      failedBefore,
      mrrCents,
      userPage,
      events,
      services,
      flags,
    ] = await Promise.all([
      this.stats.userCounts(d30),
      this.stats.planCounts(),
      this.stats.activeUsers(d30, now),
      this.stats.activeUsers(d60, d30),
      this.stats.premiumMovement(d30),
      this.stats.eventsByDay(seriesStart),
      this.stats.anonymousByDay(isoDay(seriesStart)),
      this.stats.apiRequests(d30, now),
      this.stats.apiRequests(d60, d30),
      this.stats.failedLookups(h24, now),
      this.stats.failedLookups(h48, h24),
      this.stats.monthlyRecurringCents(now),
      this.users.list({ limit: USERS_SHOWN, offset: 0 }, now),
      this.stats.recentSubscriptionEvents(EVENTS_SHOWN),
      this.system.services(now),
      this.abuse.list(FLAGS_SHOWN),
    ]);

    const perDay = new Map<
      string,
      { anonymous: number; account: number; api: number }
    >();
    for (let i = 0; i < SERIES_DAYS; i += 1) {
      perDay.set(isoDay(new Date(seriesStart.getTime() + i * DAY_MS)), {
        anonymous: 0,
        account: 0,
        api: 0,
      });
    }
    for (const row of byDay) {
      const day = perDay.get(row.day);
      if (day) {
        day[row.source === 'api' ? 'api' : 'account'] += row.count;
      }
    }
    for (const row of anonymousByDay) {
      const day = perDay.get(row.day);
      if (day) {
        day.anonymous += row.count;
      }
    }
    const dailyChecks = [...perDay].map(([date, sources]) => ({
      date,
      ...sources,
    }));

    // "Daily checks" is the last complete day against the one before it: today is still filling up.
    const totalOn = (daysAgo: number) => {
      const day = perDay.get(
        isoDay(new Date(today.getTime() - daysAgo * DAY_MS)),
      );
      return day ? day.anonymous + day.account + day.api : 0;
    };

    const premiumBefore = Math.max(
      0,
      counts.premium - movement.joined + movement.left,
    );

    return {
      totals: {
        totalUsers: metric(counts.total, counts.total - counts.createdSince),
        activeUsers: metric(active, activeBefore),
        premiumUsers: metric(counts.premium, premiumBefore),
        dailyChecks: metric(totalOn(1), totalOn(2)),
        apiRequests: metric(api, apiBefore),
        systemErrors: metric(failed, failedBefore),
      },
      mrr: mrrCents / 100,
      planMix: PLAN_ORDER.map((plan) => ({ plan, users: plans[plan] })),
      dailyChecks,
      users: userPage.users,
      subscriptionEvents: events.map((event): SubscriptionEvent => ({
        id: event.id,
        user: event.email,
        event: event.kind as SubscriptionEvent['event'],
        plan: event.plan,
        amount: event.amountCents / 100,
        at: event.at.toISOString(),
      })),
      providers: this.system.providers(now.getTime()),
      services,
      abuse: flags.map(toAbuseFlag),
    };
  }
}
