import type { AbuseStore, AbuseFlagRow } from '../abuse/abuse-store.service';
import type { AdminOverview } from '../contracts';
import {
  AdminOverviewService,
  changeSince,
  toAbuseFlag,
} from './admin-overview.service';
import type { AdminStatsStore } from './admin-stats.store';
import type { AdminSystemService } from './admin-system.service';
import type { AdminUsersService } from './admin-users.service';

const NOW = new Date('2026-09-26T12:00:00.000Z');

describe('changeSince', () => {
  it('is the change against the previous period as a ratio', () => {
    expect(changeSince(112, 100)).toBe(0.12);
    expect(changeSince(50, 100)).toBe(-0.5);
    expect(changeSince(100, 100)).toBe(0);
  });

  it('is 0 — not a made-up trend — when there is nothing to compare with', () => {
    expect(changeSince(40, 0)).toBe(0);
    expect(changeSince(0, 0)).toBe(0);
    expect(changeSince(5, -3)).toBe(0);
  });

  it('rounds to four places', () => {
    expect(changeSince(4, 3)).toBe(0.3333);
  });
});

const flagRow = (overrides: Partial<AbuseFlagRow> = {}): AbuseFlagRow => ({
  id: 'flag_1',
  kind: 'account',
  subjectKey: 'u_1',
  subjectLabel: 'ravi@example.com',
  reason: 'internal_targets',
  severity: 'high',
  events: 58,
  eventsAtDecision: 0,
  firstSeenAt: NOW,
  lastSeenAt: NOW,
  status: 'open',
  decidedBy: null,
  decidedAt: null,
  ...overrides,
});

describe('toAbuseFlag', () => {
  it('shows the label, a readable reason with the running count, and never the internal key', () => {
    const flag = toAbuseFlag(flagRow());

    expect(flag).toEqual({
      id: 'flag_1',
      subject: 'ravi@example.com',
      kind: 'account',
      reason: 'Tried 58 internal or reserved targets in an hour',
      severity: 'high',
      events: 58,
      lastSeenAt: NOW.toISOString(),
      status: 'open',
    });
    expect(JSON.stringify(flag)).not.toContain('u_1');
  });

  it('keeps a reason it does not know as it was stored', () => {
    expect(toAbuseFlag(flagRow({ reason: 'something older' })).reason).toBe(
      'something older',
    );
  });
});

const build = (
  overrides: {
    counts?: Record<string, number>;
    events?: { day: string; source: string; count: number }[];
    anonymous?: { day: string; count: number }[];
  } = {},
) => {
  const stats = {
    userCounts: jest.fn(() =>
      Promise.resolve({
        total: 120,
        createdSince: 20,
        premium: 30,
        ...overrides.counts,
      }),
    ),
    planCounts: jest.fn(() =>
      Promise.resolve({ free: 90, pro: 25, business: 5, enterprise: 0 }),
    ),
    activeUsers: jest.fn().mockResolvedValueOnce(60).mockResolvedValueOnce(40),
    premiumMovement: jest.fn(() => Promise.resolve({ joined: 8, left: 3 })),
    eventsByDay: jest.fn(() => Promise.resolve(overrides.events ?? [])),
    anonymousByDay: jest.fn(() => Promise.resolve(overrides.anonymous ?? [])),
    apiRequests: jest
      .fn()
      .mockResolvedValueOnce(900)
      .mockResolvedValueOnce(600),
    failedLookups: jest.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(8),
    monthlyRecurringCents: jest.fn(() => Promise.resolve(123_456)),
    recentSubscriptionEvents: jest.fn(() =>
      Promise.resolve([
        {
          id: 'e1',
          email: 'maya@lumen.dev',
          kind: 'upgraded',
          plan: 'business' as const,
          amountCents: 7900,
          at: NOW,
        },
      ]),
    ),
  };
  const users = {
    list: jest.fn(() =>
      Promise.resolve({
        users: [
          {
            id: 'u_1',
            name: 'Maya',
            email: 'maya@lumen.dev',
            plan: 'business' as const,
            role: 'user' as const,
            status: 'active' as const,
            lastActiveAt: NOW.toISOString(),
            checks30d: 12,
          },
        ],
        total: 1,
      }),
    ),
  };
  const system = {
    services: jest.fn(() => Promise.resolve([])),
    providers: jest.fn(() => []),
  };
  const abuse = { list: jest.fn(() => Promise.resolve([flagRow()])) };
  const service = new AdminOverviewService(
    stats as unknown as AdminStatsStore,
    users as unknown as AdminUsersService,
    system as unknown as AdminSystemService,
    abuse as unknown as AbuseStore,
  );
  return { service, stats, users, system, abuse };
};

describe('AdminOverviewService.build', () => {
  let overview: AdminOverview;

  it('works out each total against the period before it', async () => {
    const { service } = build();

    overview = await service.build(NOW);

    expect(overview.totals.totalUsers).toEqual({ value: 120, delta: 0.2 }); // 100 a month ago
    expect(overview.totals.activeUsers).toEqual({ value: 60, delta: 0.5 });
    // 30 paying now; 8 joined and 3 left in the month, so 25 a month ago
    expect(overview.totals.premiumUsers).toEqual({ value: 30, delta: 0.2 });
    expect(overview.totals.apiRequests).toEqual({ value: 900, delta: 0.5 });
    expect(overview.totals.systemErrors).toEqual({ value: 4, delta: -0.5 });
  });

  it('reports revenue in dollars and the plan mix in order', async () => {
    const { service } = build();

    overview = await service.build(NOW);

    expect(overview.mrr).toBe(1234.56);
    expect(overview.planMix).toEqual([
      { plan: 'free', users: 90 },
      { plan: 'pro', users: 25 },
      { plan: 'business', users: 5 },
      { plan: 'enterprise', users: 0 },
    ]);
  });

  it('gives thirty days, oldest first, with zeros where nothing happened', async () => {
    const { service } = build();

    overview = await service.build(NOW);

    expect(overview.dailyChecks).toHaveLength(30);
    expect(overview.dailyChecks[0].date).toBe('2026-08-28');
    expect(overview.dailyChecks[29].date).toBe('2026-09-26');
    expect(
      overview.dailyChecks.every(
        (day) => day.anonymous + day.account + day.api === 0,
      ),
    ).toBe(true);
  });

  it('splits lookups by source, web into signed-in and api into api, anonymous from the counters', async () => {
    const { service } = build({
      events: [
        { day: '2026-09-25', source: 'web', count: 40 },
        { day: '2026-09-25', source: 'api', count: 300 },
        { day: '2026-09-24', source: 'web', count: 30 },
      ],
      anonymous: [{ day: '2026-09-25', count: 12 }],
    });

    overview = await service.build(NOW);

    expect(overview.dailyChecks.find((d) => d.date === '2026-09-25')).toEqual({
      date: '2026-09-25',
      account: 40,
      api: 300,
      anonymous: 12,
    });
  });

  it('measures "daily checks" on the last complete day against the one before, not on the day still filling up', async () => {
    const { service } = build({
      events: [
        { day: '2026-09-26', source: 'web', count: 5 }, // today, partial: ignored
        { day: '2026-09-25', source: 'web', count: 150 },
        { day: '2026-09-24', source: 'web', count: 100 },
      ],
    });

    overview = await service.build(NOW);

    expect(overview.totals.dailyChecks).toEqual({ value: 150, delta: 0.5 });
  });

  it('ignores events from days outside the window', async () => {
    const { service } = build({
      events: [{ day: '2025-01-01', source: 'web', count: 999 }],
    });

    overview = await service.build(NOW);

    expect(
      overview.dailyChecks.reduce((sum, day) => sum + day.account, 0),
    ).toBe(0);
  });

  it('carries the users, subscription events, providers, services and abuse flags through', async () => {
    const { service } = build();

    overview = await service.build(NOW);

    expect(overview.users).toHaveLength(1);
    expect(overview.subscriptionEvents).toEqual([
      {
        id: 'e1',
        user: 'maya@lumen.dev',
        event: 'upgraded',
        plan: 'business',
        amount: 79,
        at: NOW.toISOString(),
      },
    ]);
    expect(overview.abuse[0]).toMatchObject({
      subject: 'ravi@example.com',
      status: 'open',
    });
  });

  it('asks for the hundred most recently active users', async () => {
    const { service, users } = build();

    await service.build(NOW);

    expect(users.list).toHaveBeenCalledWith({ limit: 100, offset: 0 }, NOW);
  });
});
