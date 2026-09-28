/** Who a signal is about. `anonymous_session` is in the contract but unused: signed-out visitors have no cookie, only a hashed network. */
export type AbuseKind =
  'account' | 'api_key' | 'ip_address' | 'anonymous_session';
export type AbuseReason =
  'internal_targets' | 'daily_limit_retries' | 'rate_limited';
export type AbuseSeverity = 'low' | 'medium' | 'high';

export interface AbuseRule {
  /** The counting window. Signals are counted in fixed slices of the clock this long. */
  windowSeconds: number;
  /** Events in one window that first make it worth an administrator's attention, and where it gets more serious. */
  low: number;
  medium: number;
  high: number;
  /** Once flagged, the flag is refreshed every this many further events, so "last seen" and the count stay current without a write per request. */
  refreshEvery: number;
}

/**
 * When behaviour becomes a flag. The numbers are deliberately well above what an honest user reaches: a typo
 * is one event, a frustrated visitor retrying after the daily limit is a handful. Below `low` nothing is stored
 * at all, so ordinary traffic costs no database writes.
 */
export const ABUSE_RULES: Record<AbuseReason, AbuseRule> = {
  /** Lookups of private, loopback or reserved targets — what an attacker probing for server-side request forgery tries. */
  internal_targets: {
    windowSeconds: 3600,
    low: 10,
    medium: 25,
    high: 60,
    refreshEvery: 10,
  },
  /** An anonymous visitor who keeps sending lookups after the daily limit turned them away. */
  daily_limit_retries: {
    windowSeconds: 86_400,
    low: 20,
    medium: 60,
    high: 200,
    refreshEvery: 20,
  },
  /** An API key that keeps sending requests over its per-minute limit. */
  rate_limited: {
    windowSeconds: 3600,
    low: 100,
    medium: 1000,
    high: 5000,
    refreshEvery: 100,
  },
};

/** Null while the count is still under the bar for a flag. */
export const severityFor = (
  reason: AbuseReason,
  events: number,
): AbuseSeverity | null => {
  const rule = ABUSE_RULES[reason];
  if (events >= rule.high) {
    return 'high';
  }
  if (events >= rule.medium) {
    return 'medium';
  }
  return events >= rule.low ? 'low' : null;
};

/**
 * Whether the row should be written now. Crossing a bar always writes; after that only every
 * `refreshEvery` events, so a client hammering an endpoint costs a write per hundred requests, not per request.
 */
export const shouldRecord = (reason: AbuseReason, count: number): boolean => {
  const rule = ABUSE_RULES[reason];
  if (count < rule.low) {
    return false;
  }
  return (
    count === rule.low ||
    count === rule.medium ||
    count === rule.high ||
    count % rule.refreshEvery === 0
  );
};

/** A dismissed flag comes back only when the behaviour has doubled since the decision — a one-off dismissal shouldn't be re-litigated by the same trickle. */
export const shouldReopen = (
  status: string,
  events: number,
  eventsAtDecision: number,
): boolean =>
  status === 'dismissed' &&
  eventsAtDecision > 0 &&
  events >= eventsAtDecision * 2;

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;

/** What an administrator reads. Built when listed, from the code and the running count, so it never goes stale. */
export const describeReason = (reason: AbuseReason, events: number): string => {
  switch (reason) {
    case 'internal_targets':
      return `Tried ${plural(events, 'internal or reserved target', 'internal or reserved targets')} in an hour`;
    case 'daily_limit_retries':
      return `Kept asking after the daily limit: ${plural(events, 'request', 'requests')} refused in a day`;
    case 'rate_limited':
      return `${plural(events, 'request', 'requests')} over the per-minute limit in an hour`;
  }
};

export const isAbuseReason = (value: string): value is AbuseReason =>
  Object.hasOwn(ABUSE_RULES, value);
