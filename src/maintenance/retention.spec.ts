import {
  RETENTION_DEFAULTS,
  parseDays,
  readRetention,
  retentionCutoffs,
} from './retention';

describe('parseDays', () => {
  it.each([
    ['30', 30],
    [' 30 ', 30],
    [undefined, 9],
    ['', 9],
    ['   ', 9],
    ['0', 9],
    ['-5', 9],
    ['2.5', 9],
    ['soon', 9],
  ])('%p -> %p', (raw, expected) => {
    expect(parseDays(raw, 9)).toBe(expected);
  });
});

describe('readRetention', () => {
  it('uses the defaults for an empty environment', () => {
    expect(readRetention({})).toEqual({
      expiredCredentialDays: RETENTION_DEFAULTS.expiredCredentialDays,
      lookupEventDays: 200,
      anonymousCounterDays: 70,
      monthlyCounterDays: 400,
      alertDays: 365,
      bulkJobDays: 30,
    });
  });

  it('lets the two customer-facing windows be overridden', () => {
    const days = readRetention({
      LOOKUP_EVENT_RETENTION_DAYS: '120',
      ALERT_RETENTION_DAYS: '90',
    });
    expect(days.lookupEventDays).toBe(120);
    expect(days.alertDays).toBe(90);
  });

  it('never keeps lookup events for less than analytics can show', () => {
    // The longest analytics range is 90 days and it is compared with the 90 before it.
    expect(RETENTION_DEFAULTS.lookupEventDays).toBeGreaterThanOrEqual(180);
    // The admin chart covers 30 days and is compared with the 30 before it.
    expect(RETENTION_DEFAULTS.anonymousCounterDays).toBeGreaterThanOrEqual(60);
  });
});

describe('retentionCutoffs', () => {
  it('counts back whole days from now', () => {
    const now = new Date('2026-09-26T12:00:00.000Z');
    const cutoff = retentionCutoffs(now, readRetention({}));
    expect(cutoff.expiredCredentials.toISOString()).toBe(
      '2026-09-25T12:00:00.000Z',
    );
    expect(cutoff.lookupEvents.toISOString()).toBe('2026-03-10T12:00:00.000Z');
    expect(cutoff.alerts.toISOString()).toBe('2025-09-26T12:00:00.000Z');
  });
});
