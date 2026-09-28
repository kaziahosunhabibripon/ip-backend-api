import type { ConnectionType } from '../../contracts';

export interface NetworkClassification {
  connectionType: ConnectionType;
  anycast: boolean;
}

// Autonomous systems we can name with confidence. Everything else is inferred from the AS name
// (or left "unknown") — telling a home ISP from a business line takes paid data we don't have.
const CDN_ASNS = new Set([13335, 209242, 54113, 20940, 16625, 19551, 60068]);
const ANYCAST_ASNS = new Set([13335, 209242, 54113, 19551]);
const CLOUD_ASNS = new Set([
  16509, 14618, 15169, 396982, 8075, 14061, 16276, 24940, 63949, 20473, 45102,
  31898, 36351, 132203,
]);

const HOSTING =
  /\b(hosting|host|cloud|datacenter|data center|colo|colocation|vps|dedicated|servers?)\b/i;
const EDUCATION =
  /\b(universit\w*|college|school|education\w*|academic|research)\b/i;
const GOVERNMENT = /\b(government|ministry|federal|municipal|department of)\b/i;
const MOBILE = /\b(mobile|wireless|cellular|lte)\b/i;

/** Best-effort network type from the AS number and organisation name. */
export const classifyNetwork = (
  asn: number,
  organization: string,
): NetworkClassification => {
  const anycast = ANYCAST_ASNS.has(asn);

  if (CDN_ASNS.has(asn)) {
    return { connectionType: 'cdn', anycast };
  }
  if (CLOUD_ASNS.has(asn) || HOSTING.test(organization)) {
    return { connectionType: 'datacenter', anycast };
  }
  if (GOVERNMENT.test(organization)) {
    return { connectionType: 'government', anycast };
  }
  if (EDUCATION.test(organization)) {
    return { connectionType: 'education', anycast };
  }
  if (MOBILE.test(organization)) {
    return { connectionType: 'mobile', anycast };
  }

  return { connectionType: 'unknown', anycast };
};
