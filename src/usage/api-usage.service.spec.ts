import { buildApiUsage, SERIES_DAYS } from './api-usage.service';

const NOW = new Date('2026-09-24T15:30:00.000Z');

describe('buildApiUsage', () => {
  it('gives a 30-day series ending today, oldest first, with zeros where nothing happened', () => {
    const summary = buildApiUsage({
      effectivePlan: 'pro',
      plan: 'pro',
      requestsMonth: 0,
      daily: [],
      now: NOW,
    });

    expect(summary.series).toHaveLength(SERIES_DAYS);
    expect(summary.series[0]).toEqual({
      date: '2026-08-26',
      requests: 0,
      errors: 0,
    });
    expect(summary.series[29]).toEqual({
      date: '2026-09-24',
      requests: 0,
      errors: 0,
    });
    // Consecutive days, none missing across the month boundary.
    const dates = summary.series.map((point) => point.date);
    expect(new Set(dates).size).toBe(30);
    expect(dates).toEqual([...dates].sort());
  });

  it('puts each day’s figures on the right day', () => {
    const summary = buildApiUsage({
      effectivePlan: 'pro',
      plan: 'pro',
      requestsMonth: 60,
      daily: [
        { date: '2026-09-24', requests: 40, errors: 2 },
        { date: '2026-09-20', requests: 20, errors: 0 },
      ],
      now: NOW,
    });

    expect(summary.requestsToday).toBe(40);
    expect(summary.series.find((p) => p.date === '2026-09-20')).toMatchObject({
      requests: 20,
    });
  });

  it('ignores days outside the window', () => {
    const summary = buildApiUsage({
      effectivePlan: 'pro',
      plan: 'pro',
      requestsMonth: 5,
      daily: [{ date: '2026-07-01', requests: 999, errors: 999 }],
      now: NOW,
    });

    expect(summary.errorRate).toBe(0);
    expect(summary.series.every((p) => p.requests === 0)).toBe(true);
  });

  it('takes the month total from the counter, not from the log', () => {
    const summary = buildApiUsage({
      effectivePlan: 'pro',
      plan: 'pro',
      requestsMonth: 1234,
      daily: [{ date: '2026-09-24', requests: 3, errors: 0 }],
      now: NOW,
    });

    expect(summary.requestsMonth).toBe(1234);
    expect(summary.requestsToday).toBe(3);
  });

  it('works out the allowance and what is left, never below zero', () => {
    const some = buildApiUsage({
      effectivePlan: 'pro',
      plan: 'pro',
      requestsMonth: 1000,
      daily: [],
      now: NOW,
    });
    expect(some.monthlyLimit).toBe(150_000);
    expect(some.remaining).toBe(149_000);

    const over = buildApiUsage({
      effectivePlan: 'pro',
      plan: 'pro',
      requestsMonth: 160_000,
      daily: [],
      now: NOW,
    });
    expect(over.remaining).toBe(0);
  });

  it('computes the error rate over the whole window', () => {
    const summary = buildApiUsage({
      effectivePlan: 'pro',
      plan: 'pro',
      requestsMonth: 400,
      daily: [
        { date: '2026-09-23', requests: 300, errors: 3 },
        { date: '2026-09-24', requests: 100, errors: 5 },
      ],
      now: NOW,
    });

    expect(summary.errorRate).toBe(0.02);
  });

  it('has an error rate of zero — not NaN — when there were no requests', () => {
    expect(
      buildApiUsage({
        effectivePlan: 'pro',
        plan: 'pro',
        requestsMonth: 0,
        daily: [],
        now: NOW,
      }).errorRate,
    ).toBe(0);
  });

  it('reports what a production key of the plan may send per minute', () => {
    expect(
      buildApiUsage({
        effectivePlan: 'pro',
        plan: 'pro',
        requestsMonth: 0,
        daily: [],
        now: NOW,
      }).rateLimitPerMinute,
    ).toBe(1000);
    expect(
      buildApiUsage({
        effectivePlan: 'business',
        plan: 'business',
        requestsMonth: 0,
        daily: [],
        now: NOW,
      }).rateLimitPerMinute,
    ).toBe(5000);
  });

  it('gives Enterprise the enforceable cap standing in for "custom"', () => {
    expect(
      buildApiUsage({
        effectivePlan: 'enterprise',
        plan: 'enterprise',
        requestsMonth: 0,
        daily: [],
        now: NOW,
      }).monthlyLimit,
    ).toBe(1_000_000);
  });
});
