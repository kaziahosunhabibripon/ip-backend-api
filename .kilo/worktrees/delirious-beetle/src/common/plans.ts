import type { Plan, PlanLimits } from '../contracts';

export const PLAN_ORDER: Plan[] = ['free', 'pro', 'business', 'enterprise'];

/** True when `userPlan` is `requiredPlan` or any tier above it. */
export const planIncludes = (userPlan: Plan, requiredPlan: Plan): boolean =>
  PLAN_ORDER.indexOf(userPlan) >= PLAN_ORDER.indexOf(requiredPlan);

/** What each plan allows — the server-side twin of `PLANS[...].limits` in ipscope-web. `null` means unlimited / custom. */
export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: {
    lookups: 100,
    lookupPeriod: 'month',
    apiRequests: 0,
    monitors: 0,
    bulkBatchSize: 0,
    teamSeats: 0,
  },
  pro: {
    lookups: 500,
    lookupPeriod: 'month',
    apiRequests: 150_000,
    monitors: 5,
    bulkBatchSize: 100,
    teamSeats: 0,
  },
  business: {
    lookups: 5_000,
    lookupPeriod: 'month',
    apiRequests: 2_000_000,
    monitors: 100,
    bulkBatchSize: 1_000,
    teamSeats: 10,
  },
  enterprise: {
    lookups: null,
    lookupPeriod: 'month',
    apiRequests: null,
    monitors: null,
    bulkBatchSize: null,
    teamSeats: null,
  },
};

/** Enterprise is "custom" in the UI; 100k is the cap the frontend mock uses until billing defines it. */
const ENTERPRISE_LOOKUP_CAP = 100_000;

/** Lookups per month, as an enforceable number. */
export const PLAN_LOOKUP_LIMITS: Record<Plan, number> = {
  free: PLAN_LIMITS.free.lookups ?? ENTERPRISE_LOOKUP_CAP,
  pro: PLAN_LIMITS.pro.lookups ?? ENTERPRISE_LOOKUP_CAP,
  business: PLAN_LIMITS.business.lookups ?? ENTERPRISE_LOOKUP_CAP,
  enterprise: PLAN_LIMITS.enterprise.lookups ?? ENTERPRISE_LOOKUP_CAP,
};

export const ANONYMOUS_DAILY_LOOKUP_LIMIT = 2;

/** What the pricing page calls "custom" for Enterprise API traffic, as a number that can be enforced until billing defines it. */
const ENTERPRISE_API_CAP = 1_000_000;

/** API requests per month, as an enforceable number. */
export const PLAN_API_LIMITS: Record<Plan, number> = {
  free: PLAN_LIMITS.free.apiRequests ?? ENTERPRISE_API_CAP,
  pro: PLAN_LIMITS.pro.apiRequests ?? ENTERPRISE_API_CAP,
  business: PLAN_LIMITS.business.apiRequests ?? ENTERPRISE_API_CAP,
  enterprise: PLAN_LIMITS.enterprise.apiRequests ?? ENTERPRISE_API_CAP,
};

/** Requests per minute for one API key: a development key is deliberately small; a production key follows the plan. */
export const apiRateLimit = (
  plan: Plan,
  environment: 'production' | 'development',
): number => {
  if (environment === 'development') {
    return 100;
  }
  return plan === 'business' || plan === 'enterprise' ? 5000 : 1000;
};
