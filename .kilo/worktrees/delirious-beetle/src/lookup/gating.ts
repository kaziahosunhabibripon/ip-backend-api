import { canAccess, requiredPlan, type Feature } from '../common/features';
import type { DomainCheckResult, Gated, Tier } from '../contracts';

/**
 * Applies the viewer's entitlements to a result that holds everything we gathered. Anything the
 * viewer isn't entitled to is replaced by `{ access: "locked", requiredPlan }` — the premium value
 * itself never leaves the server. Idempotent, and safe to run on a stored result: a field that was
 * already locked when captured stays locked.
 */
export const applyEntitlements = (
  result: DomainCheckResult,
  tier: Tier,
): DomainCheckResult => {
  const lock = <T>(gated: Gated<T>, feature: Feature): Gated<T> =>
    canAccess(tier, feature)
      ? gated
      : { access: 'locked', requiredPlan: requiredPlan(feature) };

  return {
    ...result,
    dns: result.dns && {
      ...result.dns,
      advanced: lock(result.dns.advanced, 'advancedDns'),
    },
    reverseDns: result.reverseDns && lock(result.reverseDns, 'advancedDns'),
    ips: result.ips.map((ip) => ({
      ...ip,
      security:
        ip.security.status === 'ok'
          ? {
              ...ip.security,
              data: {
                ...ip.security.data,
                advanced: lock(
                  ip.security.data.advanced,
                  'advancedIntelligence',
                ),
              },
            }
          : ip.security,
    })),
  };
};
