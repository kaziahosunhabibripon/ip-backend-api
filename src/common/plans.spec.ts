import {
  apiRateLimit,
  PLAN_API_LIMITS,
  PLAN_LIMITS,
  PLAN_LOOKUP_LIMITS,
  planIncludes,
} from './plans';
import { quotaFromScope } from './quota';

describe('planIncludes', () => {
  it('lets a plan use its own tier and everything below it', () => {
    expect(planIncludes('pro', 'pro')).toBe(true);
    expect(planIncludes('pro', 'free')).toBe(true);
    expect(planIncludes('enterprise', 'business')).toBe(true);
  });

  it('blocks a plan from tiers above it', () => {
    expect(planIncludes('free', 'pro')).toBe(false);
    expect(planIncludes('pro', 'business')).toBe(false);
    expect(planIncludes('business', 'enterprise')).toBe(false);
  });
});

describe('plan limits', () => {
  it('matches the numbers the pricing page promises', () => {
    expect(PLAN_LIMITS.free).toMatchObject({
      lookups: 100,
      apiRequests: 0,
      monitors: 0,
    });
    expect(PLAN_LIMITS.pro).toMatchObject({
      lookups: 500,
      apiRequests: 150_000,
      monitors: 5,
      bulkBatchSize: 100,
    });
    expect(PLAN_LIMITS.business).toMatchObject({
      lookups: 5_000,
      apiRequests: 2_000_000,
      monitors: 100,
      bulkBatchSize: 1_000,
    });
  });

  it('leaves Enterprise unlimited in the table but capped when it has to be enforced', () => {
    expect(PLAN_LIMITS.enterprise.lookups).toBeNull();
    expect(PLAN_LOOKUP_LIMITS.enterprise).toBe(100_000);
  });

  it('gives every plan an enforceable lookup number', () => {
    for (const plan of ['free', 'pro', 'business', 'enterprise'] as const) {
      expect(Number.isInteger(PLAN_LOOKUP_LIMITS[plan])).toBe(true);
    }
  });
});

describe('API limits', () => {
  it('matches the requests a month the pricing page promises', () => {
    expect(PLAN_API_LIMITS.free).toBe(0);
    expect(PLAN_API_LIMITS.pro).toBe(150_000);
    expect(PLAN_API_LIMITS.business).toBe(2_000_000);
  });

  it('gives Enterprise an enforceable number while its table entry stays "custom"', () => {
    expect(PLAN_LIMITS.enterprise.apiRequests).toBeNull();
    expect(PLAN_API_LIMITS.enterprise).toBe(1_000_000);
  });

  it('keeps a production key at the plan’s rate and a development key at 100 a minute', () => {
    expect(apiRateLimit('pro', 'production')).toBe(1000);
    expect(apiRateLimit('business', 'production')).toBe(5000);
    expect(apiRateLimit('enterprise', 'production')).toBe(5000);
    for (const plan of ['free', 'pro', 'business', 'enterprise'] as const) {
      expect(apiRateLimit(plan, 'development')).toBe(100);
    }
  });
});

describe('quotaFromScope', () => {
  const resetsAt = new Date('2026-10-01T00:00:00.000Z');

  it('describes the monthly API allowance as the account’s monthly quota', () => {
    expect(
      quotaFromScope({ kind: 'api', limit: 150_000, resetsAt }, 42),
    ).toEqual({
      scope: 'account',
      used: 42,
      limit: 150_000,
      period: 'month',
      resetsAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('keeps anonymous quotas daily', () => {
    expect(
      quotaFromScope({ kind: 'anonymous', limit: 2, resetsAt }, 1),
    ).toMatchObject({ scope: 'anonymous', period: 'day' });
  });
});
