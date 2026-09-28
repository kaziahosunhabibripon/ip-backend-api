import {
  ABUSE_RULES,
  describeReason,
  isAbuseReason,
  severityFor,
  shouldRecord,
  shouldReopen,
  type AbuseReason,
} from './abuse-rules';

const REASONS = Object.keys(ABUSE_RULES) as AbuseReason[];

describe('ABUSE_RULES', () => {
  it.each(REASONS)('%s has thresholds that rise', (reason) => {
    const rule = ABUSE_RULES[reason];
    expect(rule.low).toBeGreaterThan(1); // a single event is never a flag
    expect(rule.medium).toBeGreaterThan(rule.low);
    expect(rule.high).toBeGreaterThan(rule.medium);
    expect(rule.windowSeconds).toBeGreaterThan(0);
    expect(rule.refreshEvery).toBeGreaterThan(0);
  });
});

describe('severityFor', () => {
  it('is null until the count reaches the first bar', () => {
    expect(severityFor('internal_targets', 0)).toBeNull();
    expect(severityFor('internal_targets', 9)).toBeNull();
  });

  it('steps up at each bar', () => {
    expect(severityFor('internal_targets', 10)).toBe('low');
    expect(severityFor('internal_targets', 24)).toBe('low');
    expect(severityFor('internal_targets', 25)).toBe('medium');
    expect(severityFor('internal_targets', 59)).toBe('medium');
    expect(severityFor('internal_targets', 60)).toBe('high');
    expect(severityFor('internal_targets', 5000)).toBe('high');
  });

  it('holds each reason to its own bars', () => {
    expect(severityFor('rate_limited', 99)).toBeNull();
    expect(severityFor('rate_limited', 100)).toBe('low');
    expect(severityFor('daily_limit_retries', 19)).toBeNull();
    expect(severityFor('daily_limit_retries', 200)).toBe('high');
  });
});

describe('shouldRecord', () => {
  it('writes nothing below the first bar, so ordinary traffic costs no database writes', () => {
    for (let count = 1; count < ABUSE_RULES.internal_targets.low; count += 1) {
      expect(shouldRecord('internal_targets', count)).toBe(false);
    }
  });

  it('writes when a bar is crossed', () => {
    expect(shouldRecord('internal_targets', 10)).toBe(true);
    expect(shouldRecord('internal_targets', 25)).toBe(true);
    expect(shouldRecord('internal_targets', 60)).toBe(true);
  });

  it('then only every few events, so a hammering client is not a write per request', () => {
    const writes = Array.from({ length: 1000 }, (_, i) => i + 1).filter(
      (count) => shouldRecord('rate_limited', count),
    );

    // 100, 200, …, 1000 — one in a hundred, and the medium bar (1000) coincides with a multiple.
    expect(writes).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
  });
});

describe('shouldReopen', () => {
  it('reopens a dismissed flag only when the behaviour has doubled since the decision', () => {
    expect(shouldReopen('dismissed', 19, 10)).toBe(false);
    expect(shouldReopen('dismissed', 20, 10)).toBe(true);
    expect(shouldReopen('dismissed', 500, 10)).toBe(true);
  });

  it('leaves everything else alone', () => {
    expect(shouldReopen('open', 500, 10)).toBe(false);
    expect(shouldReopen('blocked', 500, 10)).toBe(false);
    expect(shouldReopen('dismissed', 500, 0)).toBe(false); // never decided
  });
});

describe('describeReason', () => {
  it('reads as a sentence with the running count, in the singular too', () => {
    expect(describeReason('internal_targets', 58)).toContain(
      '58 internal or reserved targets',
    );
    expect(describeReason('internal_targets', 1)).toContain(
      '1 internal or reserved target ',
    );
    expect(describeReason('rate_limited', 4200)).toContain('4,200 requests');
    expect(describeReason('daily_limit_retries', 40)).toContain(
      '40 requests refused',
    );
  });
});

describe('isAbuseReason', () => {
  it('knows its own reasons and nothing else', () => {
    expect(isAbuseReason('rate_limited')).toBe(true);
    expect(isAbuseReason('something_old')).toBe(false);
    expect(isAbuseReason('toString')).toBe(false);
  });
});
