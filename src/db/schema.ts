import {
  pgTable,
  pgEnum,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  serial,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import type {
  BulkItemError,
  BulkItemStatus,
  BulkItemSummary,
  BulkJobStatus,
  BulkStopReason,
  DomainCheckResult,
  InputType,
  MonitorWatch,
  NotificationPreferences,
} from '../contracts';
import type { MonitorSnapshot } from '../monitoring/snapshot';

export const planEnum = pgEnum('plan', [
  'free',
  'pro',
  'business',
  'enterprise',
]);
export const roleEnum = pgEnum('role', ['user', 'admin']);
export const authTokenTypeEnum = pgEnum('auth_token_type', [
  'email_verification',
  'password_reset',
  'team_invite',
]);

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  monitorAlerts: true,
  securityAlerts: true,
  weeklyDigest: false,
  usageWarnings: true,
  productUpdates: false,
};

export const users = pgTable('users', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  plan: planEnum('plan').notNull().default('free'),
  role: roleEnum('role').notNull().default('user'),
  emailVerified: boolean('email_verified').notNull().default(false),
  notificationPreferences: jsonb('notification_preferences')
    .$type<NotificationPreferences>()
    .notNull()
    .default(DEFAULT_NOTIFICATION_PREFERENCES),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  /** Set when an administrator suspends the account; null for everyone else. A suspended user can't sign in, use a session or use an API key. */
  suspendedAt: timestamp('suspended_at'),
  suspensionReason: text('suspension_reason'),
});

export const usersRelations = relations(users, ({ many, one }) => ({
  history: many(historyItems),
  monitors: many(monitors),
  apiKeys: many(apiKeys),
  sessions: many(sessions),
  authTokens: many(authTokens),
  subscription: one(subscriptions),
}));

/** One row per signed-in browser. The cookie holds a random token; only its SHA-256 is stored here. Revoking a session deletes the row. */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    lastActiveAt: timestamp('last_active_at').notNull().defaultNow(),
    expiresAt: timestamp('expires_at').notNull(),
  },
  (table) => ({
    userIdx: index('sessions_user_id_idx').on(table.userId),
  }),
);

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

/** Single-use emailed tokens (email verification, password reset). Only the SHA-256 is stored; using a token deletes the row. */
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: authTokenTypeEnum('type').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    userTypeIdx: index('auth_tokens_user_id_type_idx').on(
      table.userId,
      table.type,
    ),
  }),
);

export const authTokensRelations = relations(authTokens, ({ one }) => ({
  user: one(users, { fields: [authTokens.userId], references: [users.id] }),
}));

export const historyItems = pgTable(
  'history_items',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    target: text('target').notNull(),
    type: text('type').notNull(),
    status: text('status').notNull(),
    ipCount: integer('ip_count').notNull().default(0),
    /** The full result as captured, so a saved check can be reopened without spending a lookup. Gated fields are re-applied on read. */
    result: jsonb('result').$type<DomainCheckResult>(),
    checkedAt: timestamp('checked_at').notNull().defaultNow(),
  },
  (table) => ({
    userCheckedAtIdx: index('history_items_user_id_checked_at_idx').on(
      table.userId,
      table.checkedAt,
    ),
  }),
);

export const historyItemsRelations = relations(historyItems, ({ one }) => ({
  user: one(users, { fields: [historyItems.userId], references: [users.id] }),
}));

export const monitors = pgTable(
  'monitors',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    target: text('target').notNull(),
    targetType: text('target_type').notNull().default('domain'),
    /** Minutes between runs. */
    intervalMinutes: integer('interval_minutes').notNull().default(15),
    /** Which kinds of change raise an alert. */
    watch: jsonb('watch')
      .$type<MonitorWatch[]>()
      .notNull()
      .default(['dns', 'ip', 'provider', 'security']),
    /** False while the user has paused it. */
    enabled: boolean('enabled').notNull().default(true),
    /**
     * 'healthy' or 'failing' — whether the last runs could read the target at all. What the UI calls
     * "paused" and "changed" is derived on read (from `enabled` and unread alerts), so it can't go stale.
     */
    status: text('status').notNull().default('healthy'),
    /** Runs in a row that couldn't read the target; three flips the monitor to failing. */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    /** The last good look at the target, to compare the next one with. */
    lastResult: jsonb('last_result').$type<MonitorSnapshot>(),
    lastCheckedAt: timestamp('last_checked_at'),
    /** When the scheduler should run it next; also pushed forward as a lease while a run is in flight. */
    nextCheckAt: timestamp('next_check_at'),
    /** When the last alert email went out, so a flapping target can't flood an inbox. */
    lastEmailedAt: timestamp('last_emailed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    userTargetIdx: uniqueIndex('monitors_user_id_target_idx').on(
      table.userId,
      table.target,
    ),
    dueIdx: index('monitors_due_idx').on(table.enabled, table.nextCheckAt),
  }),
);

export const monitorsRelations = relations(monitors, ({ one, many }) => ({
  user: one(users, { fields: [monitors.userId], references: [users.id] }),
  alerts: many(alerts),
}));

/**
 * The user's inbox. It belongs to the user, not the monitor: deleting a monitor keeps its alerts
 * (the monitoring page promises "existing alerts stay in your inbox"), so the target is copied onto the row.
 */
export const alerts = pgTable(
  'alerts',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    monitorId: text('monitor_id').references(() => monitors.id, {
      onDelete: 'set null',
    }),
    type: text('type').notNull(),
    severity: text('severity').notNull(),
    category: text('category').notNull(),
    target: text('target').notNull(),
    message: text('message').notNull(),
    /** A short line for "latest change" on the monitor. */
    summary: text('summary').notNull(),
    /** Which watched kind of change this was; null for a failure. Feeds the per-kind 30-day counts. */
    watch: text('watch'),
    read: boolean('read').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    userCreatedIdx: index('alerts_user_id_created_at_idx').on(
      table.userId,
      table.createdAt,
    ),
    monitorIdx: index('alerts_monitor_id_idx').on(table.monitorId),
  }),
);

export const alertsRelations = relations(alerts, ({ one }) => ({
  user: one(users, { fields: [alerts.userId], references: [users.id] }),
  monitor: one(monitors, {
    fields: [alerts.monitorId],
    references: [monitors.id],
  }),
}));

/**
 * API keys for calling `POST /check` from code. The secret is shown once at creation and never stored:
 * only its SHA-256 is (`secret_hash`, looked up on every request), plus a short non-secret `prefix` so the
 * key can be recognised in a list. The requests-per-minute limit isn't stored either — it follows the
 * owner's plan and the key's environment, so it can't go stale when the plan changes.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    secretHash: text('secret_hash').notNull(),
    /** 'production' (live) or 'development' (test). */
    environment: text('environment').notNull(),
    /** 'active' or 'revoked'. A revoked key stops working at once but stays listed. */
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    /** Rounded to the minute at best: it is only rewritten when the last value is over a minute old. */
    lastUsedAt: timestamp('last_used_at'),
    revokedAt: timestamp('revoked_at'),
  },
  (table) => ({
    secretHashIdx: uniqueIndex('api_keys_secret_hash_idx').on(table.secretHash),
    userCreatedIdx: index('api_keys_user_id_created_at_idx').on(
      table.userId,
      table.createdAt,
    ),
  }),
);

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, { fields: [apiKeys.userId], references: [users.id] }),
}));

/**
 * What a user has paid for: one row per user, rewritten only inside the transaction that settles a payment (or ends a
 * period), and `users.plan` — what the limits are enforced from — moves with it. Plans are prepaid: `plan` is the plan
 * running now (`free` once a period ends), `current_period_end` when it stops, and `queued_*` a plan already paid for
 * that starts then. `amount_cents` is the list price of everything paid for in the current span, which is what unused
 * days are credited against.
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The plan running now; 'free' when there is none. */
    plan: planEnum('plan').notNull(),
    billingCycle: text('billing_cycle').notNull(),
    /** 'active' while a paid period is running, 'expired' once it has ended and nothing followed. */
    status: text('status').notNull().default('active'),
    currentPeriodStart: timestamp('current_period_start'),
    currentPeriodEnd: timestamp('current_period_end'),
    /** The list price of everything paid for in the current span, in cents. */
    amountCents: integer('amount_cents').notNull().default(0),
    /** When this row last changed because of a payment or the end of a period. */
    syncedAt: timestamp('synced_at'),
    /** A plan already paid for that starts when the current period ends (a downgrade is bought now and begins at renewal). */
    queuedPlan: planEnum('queued_plan'),
    queuedCycle: text('queued_cycle'),
    /** The period end each notice was last sent for, so a reminder goes out once per period and a renewal re-arms it. */
    remindedWeekFor: timestamp('reminded_week_for'),
    remindedDayFor: timestamp('reminded_day_for'),
    expiryNotifiedFor: timestamp('expiry_notified_for'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    periodEndIdx: index('subscriptions_current_period_end_idx').on(
      table.currentPeriodEnd,
    ),
  }),
);

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  user: one(users, {
    fields: [subscriptions.userId],
    references: [users.id],
  }),
}));

/**
 * One row per payment asked of the payment gateway (`payment-gateway-api`): a one-off invoice that buys, renews or
 * changes a paid period. The gateway settles it (we learn by polling it, and by its signed webhook when it sends
 * one); `applied_at` is set in the same transaction that grants the period, so however the news arrives — webhook,
 * poll, both at once — the plan is granted exactly once. These rows are also the billing history.
 */
export const payments = pgTable(
  'payments',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    /** Numbers the invoices for people: IPS-00042. */
    seq: serial('seq').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    plan: planEnum('plan').notNull(),
    billingCycle: text('billing_cycle').notNull(),
    /** 'purchase' | 'renewal' | 'upgrade' | 'queue'. */
    kind: text('kind').notNull(),
    /** What the gateway invoice charges, in cents. */
    amountCents: integer('amount_cents').notNull(),
    /** What was taken off for the unused days of the plan being replaced. */
    creditCents: integer('credit_cents').notNull().default(0),
    /** The plan's price for the cycle: what the period is worth, whatever was actually charged. */
    listPriceCents: integer('list_price_cents').notNull(),
    /** 'pending' | 'paid' | 'failed' | 'expired' | 'refunded'. */
    status: text('status').notNull().default('pending'),
    /** The gateway's own number for the invoice. */
    gatewayInvoiceNo: text('gateway_invoice_no').notNull(),
    checkoutUrl: text('checkout_url'),
    expiresAt: timestamp('expires_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    paidAt: timestamp('paid_at'),
    /** Set, atomically with the grant, when this payment's period was given to the user. Null until then. */
    appliedAt: timestamp('applied_at'),
    /** When the poller should ask the gateway about it next, and how many times it has. */
    nextPollAt: timestamp('next_poll_at').notNull().defaultNow(),
    pollAttempts: integer('poll_attempts').notNull().default(0),
  },
  (table) => ({
    invoiceIdx: uniqueIndex('payments_gateway_invoice_no_idx').on(
      table.gatewayInvoiceNo,
    ),
    userCreatedIdx: index('payments_user_id_created_at_idx').on(
      table.userId,
      table.createdAt,
    ),
    pollIdx: index('payments_status_next_poll_at_idx').on(
      table.status,
      table.nextPollAt,
    ),
  }),
);

/**
 * Lookups used per quota window. `key` is `user:<id>:YYYY-MM` for accounts and
 * `anon:<hash of the visitor's IP>:YYYY-MM-DD` for signed-out visitors — hashed, so the table
 * never holds a raw IP address.
 */
export const usageCounters = pgTable('usage_counters', {
  key: text('key').primaryKey(),
  count: integer('count').notNull().default(0),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

/**
 * One row per lookup a signed-in user made — including cache hits and failures, which the saved
 * history leaves out — so usage analytics can show success rate, cache hit rate and provider latency.
 * Holds no target: deleting a check from history also removes it from the "top targets" list.
 */
export const lookupEvents = pgTable(
  'lookup_events',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    at: timestamp('at').notNull().defaultNow(),
    /** 'web' for the site; Phase 5 writes 'api' for key-authenticated calls. */
    source: text('source').notNull().default('web'),
    /** The check's status, or 'failed' when nothing came back (DNS timeout, every provider down). */
    status: text('status').notNull(),
    cacheHit: boolean('cache_hit').notNull().default(false),
    durationMs: integer('duration_ms').notNull().default(0),
    /** Milliseconds per provider that answered, for fresh (non-cached) runs: { dns, geo, asn, security }. */
    latency:
      jsonb('latency').$type<
        Partial<Record<'dns' | 'geo' | 'asn' | 'security', number>>
      >(),
  },
  (table) => ({
    userAtIdx: index('lookup_events_user_id_at_idx').on(table.userId, table.at),
  }),
);

/**
 * What happened to a subscription, for the admin view and for working out how many paying customers there
 * were a month ago. Written by billing when a Stripe snapshot changes a plan or ends a subscription, and
 * when an invoice is paid at renewal or fails. `dedupe_key` makes the invoice-driven ones idempotent.
 */
export const subscriptionEvents = pgTable(
  'subscription_events',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'upgraded' | 'downgraded' | 'canceled' | 'renewed' | 'payment_failed'. */
    kind: text('kind').notNull(),
    /** The plan the event is about: the new plan for a change, the ended plan for a cancellation. */
    plan: planEnum('plan').notNull(),
    /** The plan before a change; null for renewals and failed payments. */
    fromPlan: planEnum('from_plan'),
    /** In cents: what one cycle of `plan` costs, or the invoice amount. */
    amountCents: integer('amount_cents').notNull().default(0),
    dedupeKey: text('dedupe_key').unique(),
    at: timestamp('at').notNull().defaultNow(),
  },
  (table) => ({
    atIdx: index('subscription_events_at_idx').on(table.at),
  }),
);

/**
 * Something that looks like abuse, one row per (kind, subject, reason) so the admin view lists each
 * offender once. Signals are counted in the shared cache and only become a row once they pass a threshold
 * (`src/abuse/abuse-rules.ts`), so a single typo never shows up here. `subject_key` is the stable id
 * (a user id, an API key id, a hashed network); `subject_label` is what a person can read.
 */
export const abuseFlags = pgTable(
  'abuse_flags',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    /** 'account' | 'api_key' | 'ip_address' | 'anonymous_session'. */
    kind: text('kind').notNull(),
    subjectKey: text('subject_key').notNull(),
    subjectLabel: text('subject_label').notNull(),
    /** A code from `abuse-rules.ts`, e.g. 'internal_targets'. */
    reason: text('reason').notNull(),
    /** 'low' | 'medium' | 'high'. */
    severity: text('severity').notNull(),
    events: integer('events').notNull(),
    /** `events` when an administrator last decided, so a dismissed flag only reopens when the behaviour doubles. */
    eventsAtDecision: integer('events_at_decision').notNull().default(0),
    firstSeenAt: timestamp('first_seen_at').notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at').notNull().defaultNow(),
    /** 'open' | 'blocked' | 'dismissed'. */
    status: text('status').notNull().default('open'),
    decidedBy: text('decided_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    decidedAt: timestamp('decided_at'),
  },
  (table) => ({
    subjectIdx: uniqueIndex('abuse_flags_subject_reason_idx').on(
      table.kind,
      table.subjectKey,
      table.reason,
    ),
    statusSeenIdx: index('abuse_flags_status_last_seen_idx').on(
      table.status,
      table.lastSeenAt,
    ),
  }),
);

/** Networks (hashed, like `usage_counters` — never a raw IP) that administrators have blocked from anonymous lookups. */
export const blockedVisitors = pgTable('blocked_visitors', {
  visitorHash: text('visitor_hash').primaryKey(),
  reason: text('reason').notNull(),
  blockedBy: text('blocked_by').references(() => users.id, {
    onDelete: 'set null',
  }),
  blockedAt: timestamp('blocked_at').notNull().defaultNow(),
});

/** What administrators did and to whom. The actor's email is copied in so the trail survives an account deletion. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    actorId: text('actor_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    actorEmail: text('actor_email').notNull(),
    /** e.g. 'user.suspend', 'user.reactivate', 'abuse.block'. */
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    detail:
      jsonb('detail').$type<Record<string, string | number | boolean | null>>(),
    at: timestamp('at').notNull().defaultNow(),
  },
  (table) => ({
    atIdx: index('audit_log_at_idx').on(table.at),
  }),
);

/**
 * A batch of lookups a Pro+ user submitted at once. The rows live in `bulk_items`; a worker takes the job under a
 * lease (`leased_until`), works through the pending rows a few at a time and lets the lease run out if it dies,
 * so any instance can pick the job up where it stopped. The counts a job shows are worked out from its rows, never stored.
 */
export const bulkJobs = pgTable(
  'bulk_jobs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name'),
    status: text('status').$type<BulkJobStatus>().notNull().default('queued'),
    /** Repeats left out when the batch was submitted. */
    duplicates: integer('duplicates').notNull().default(0),
    stoppedReason: text('stopped_reason').$type<BulkStopReason>(),
    /** Whoever holds the job works on it until this moment; null when nobody does. */
    leasedUntil: timestamp('leased_until'),
    /** When a worker last worked on the job, so several jobs are served in turn instead of one after another. */
    lastRunAt: timestamp('last_run_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    startedAt: timestamp('started_at'),
    finishedAt: timestamp('finished_at'),
  },
  (table) => ({
    userCreatedIdx: index('bulk_jobs_user_id_created_at_idx').on(
      table.userId,
      table.createdAt,
    ),
    statusIdx: index('bulk_jobs_status_idx').on(table.status),
  }),
);

/** One line of a bulk job. Holds a summary of the result, not the whole report: a single lookup reopens it from the cache. */
export const bulkItems = pgTable(
  'bulk_items',
  {
    jobId: text('job_id')
      .notNull()
      .references(() => bulkJobs.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    input: text('input').notNull(),
    target: text('target'),
    type: text('type').$type<InputType>(),
    status: text('status').$type<BulkItemStatus>().notNull().default('pending'),
    summary: jsonb('summary').$type<BulkItemSummary>(),
    error: jsonb('error').$type<BulkItemError>(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.jobId, table.position] }),
    jobStatusIdx: index('bulk_items_job_id_status_idx').on(
      table.jobId,
      table.status,
    ),
  }),
);

export const teamMemberStatusEnum = pgEnum('team_member_status', [
  'invited',
  'active',
]);

/**
 * One per Business+ owner (`owner_id` is unique — a person owns at most one team). The owner is never a row
 * in `team_members`; they are found through this table instead. A team has no billing of its own: its
 * "plan" is simply whatever the owner's own account currently pays for, read fresh each time it matters
 * (see `TeamsService.effectivePlan`), so an owner's upgrade or downgrade reaches every member at once.
 */
export const teams = pgTable('teams', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  ownerId: text('owner_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

/**
 * A seat on someone else's team — invited or active. Only ever an existing account (invites are looked up
 * by email at send time, never held for someone who hasn't signed up). `user_id` is unique: leaving or being
 * removed deletes the row, which is what lets a person join a different team later. Row deleted, not the
 * status flipped to something like 'removed' — nothing here needs the history of a membership that ended.
 */
export const teamMembers = pgTable(
  'team_members',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: teamMemberStatusEnum('status').notNull().default('invited'),
    invitedAt: timestamp('invited_at').notNull().defaultNow(),
    joinedAt: timestamp('joined_at'),
  },
  (table) => ({
    teamIdx: index('team_members_team_id_idx').on(table.teamId),
  }),
);

export const teamsRelations = relations(teams, ({ one, many }) => ({
  owner: one(users, { fields: [teams.ownerId], references: [users.id] }),
  members: many(teamMembers),
}));

export const teamMembersRelations = relations(teamMembers, ({ one }) => ({
  team: one(teams, { fields: [teamMembers.teamId], references: [teams.id] }),
  user: one(users, { fields: [teamMembers.userId], references: [users.id] }),
}));
