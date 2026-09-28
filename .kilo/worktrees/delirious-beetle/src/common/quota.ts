import type { QuotaSnapshot, User } from '../contracts';
import { ANONYMOUS_DAILY_LOOKUP_LIMIT, PLAN_LOOKUP_LIMITS } from './plans';

export const startOfNextUtcDay = (now: Date) =>
  new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );

export const startOfNextUtcMonth = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

/**
 * The viewer's lookup quota. `used` is always 0 for now — lookups aren't recorded until the
 * usage tracking in Phase 3, which will pass the real count in.
 */
export const buildQuotaSnapshot = (
  user: User | null,
  used = 0,
  now = new Date(),
): QuotaSnapshot =>
  user
    ? {
        scope: 'account',
        used,
        limit: PLAN_LOOKUP_LIMITS[user.effectivePlan],
        period: 'month',
        resetsAt: startOfNextUtcMonth(now).toISOString(),
      }
    : {
        scope: 'anonymous',
        used,
        limit: ANONYMOUS_DAILY_LOOKUP_LIMIT,
        period: 'day',
        resetsAt: startOfNextUtcDay(now).toISOString(),
      };

/**
 * The quota snapshot for whichever window a request was counted in. For a request made with an API key
 * that is the monthly API allowance (reported as the account's monthly quota), not the web lookups.
 */
export const quotaFromScope = (
  scope: {
    kind: 'account' | 'anonymous' | 'api';
    limit: number;
    resetsAt: Date;
  },
  used: number,
): QuotaSnapshot => ({
  scope: scope.kind === 'anonymous' ? 'anonymous' : 'account',
  used,
  limit: scope.limit,
  period: scope.kind === 'anonymous' ? 'day' : 'month',
  resetsAt: scope.resetsAt.toISOString(),
});
