import type { Plan, Tier, User } from '../contracts';

/**
 * The entitlement matrix — the server-side twin of `lib/config/features.ts` in ipscope-web (LLD §18).
 * The frontend only decides what to draw; this decides what a caller is allowed to receive.
 */
export type Feature =
  | 'history'
  | 'advancedIntelligence'
  | 'advancedDns'
  | 'bulkLookup'
  | 'export'
  | 'apiAccess'
  | 'monitoring'
  | 'alerts'
  | 'usageAnalytics'
  | 'teams';

const TIER_RANK: Record<Tier, number> = {
  anonymous: 0,
  free: 1,
  pro: 2,
  business: 3,
  enterprise: 4,
};

const FEATURE_MIN_PLAN: Record<Feature, Plan> = {
  history: 'free',
  advancedIntelligence: 'pro',
  advancedDns: 'pro',
  bulkLookup: 'pro',
  export: 'pro',
  apiAccess: 'pro',
  monitoring: 'pro',
  alerts: 'pro',
  usageAnalytics: 'pro',
  teams: 'business',
};

/**
 * `effectivePlan` (own plan, or a team owner's if higher — see `TeamsService.effectivePlan`) is what decides
 * every feature gate and quota limit; `plan` alone is what the account has actually paid for and is what
 * billing shows. Anything built straight from a database row (`toUser`) carries `effectivePlan === plan`
 * until something enriches it — today that's `AuthGuard` for a live request and `MonitorRunner`/`BulkRunner`
 * for the background jobs that check entitlement fresh on every run.
 */
export const tierOf = (
  user: Pick<User, 'effectivePlan'> | null | undefined,
): Tier => (user ? user.effectivePlan : 'anonymous');

export const canAccess = (tier: Tier, feature: Feature): boolean =>
  TIER_RANK[tier] >= TIER_RANK[FEATURE_MIN_PLAN[feature]];

export const requiredPlan = (feature: Feature): Plan =>
  FEATURE_MIN_PLAN[feature];
