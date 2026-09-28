const DAY_MS = 86_400_000;

/**
 * How long each kind of bookkeeping is kept. The defaults follow what the product can still show:
 * analytics reach back 90 days and compare with the 90 before that, so a lookup event stays 200 days;
 * the admin view charts anonymous usage for 30 days plus the 30 it is compared with.
 */
export const RETENTION_DEFAULTS = {
  /** Sessions and emailed tokens are dead the moment they expire; a day's grace just keeps them out of a clock-skew argument. */
  expiredCredentialDays: 1,
  lookupEventDays: 200,
  anonymousCounterDays: 70,
  /** Monthly per-user and per-key counters: one tiny row per user per month, kept for a year and change. */
  monthlyCounterDays: 400,
  alertDays: 365,
  /** A finished bulk batch and its results; a person downloads them soon after, or not at all. */
  bulkJobDays: 30,
} as const;

export type RetentionDays = {
  -readonly [K in keyof typeof RETENTION_DEFAULTS]: number;
};

export interface RetentionCutoffs {
  expiredCredentials: Date;
  lookupEvents: Date;
  anonymousCounters: Date;
  monthlyCounters: Date;
  alerts: Date;
  bulkJobs: Date;
}

/** A positive whole number of days, or the fallback for anything else (unset, empty, zero, negative, text). */
export const parseDays = (
  raw: string | undefined,
  fallback: number,
): number => {
  const value = Number(raw);
  return raw?.trim() && Number.isInteger(value) && value > 0 ? value : fallback;
};

export const readRetention = (
  env: Record<string, string | undefined>,
): RetentionDays => ({
  expiredCredentialDays: RETENTION_DEFAULTS.expiredCredentialDays,
  lookupEventDays: parseDays(
    env.LOOKUP_EVENT_RETENTION_DAYS,
    RETENTION_DEFAULTS.lookupEventDays,
  ),
  anonymousCounterDays: RETENTION_DEFAULTS.anonymousCounterDays,
  monthlyCounterDays: RETENTION_DEFAULTS.monthlyCounterDays,
  alertDays: parseDays(env.ALERT_RETENTION_DAYS, RETENTION_DEFAULTS.alertDays),
  bulkJobDays: parseDays(
    env.BULK_RETENTION_DAYS,
    RETENTION_DEFAULTS.bulkJobDays,
  ),
});

export const retentionCutoffs = (
  now: Date,
  days: RetentionDays,
): RetentionCutoffs => {
  const before = (n: number) => new Date(now.getTime() - n * DAY_MS);
  return {
    expiredCredentials: before(days.expiredCredentialDays),
    lookupEvents: before(days.lookupEventDays),
    anonymousCounters: before(days.anonymousCounterDays),
    monthlyCounters: before(days.monthlyCounterDays),
    alerts: before(days.alertDays),
    bulkJobs: before(days.bulkJobDays),
  };
};
