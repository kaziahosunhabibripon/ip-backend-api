import type { CheckHistory, InputType, ProviderKey } from "./lookup";
import type { Plan, Role } from "./account";

// ------------------------------------------------------------------ API keys

export type ApiKeyEnvironment = "production" | "development";
export type ApiKeyStatus = "active" | "revoked";

/** Everything about a key except the secret, which is only ever returned once at creation. */
export interface ApiKey {
  id: string;
  name: string;
  environment: ApiKeyEnvironment;
  /** Non-secret display prefix, e.g. `ips_live_a1b2`. */
  prefix: string;
  status: ApiKeyStatus;
  createdAt: string;
  lastUsedAt: string | null;
  /** Requests per minute. */
  rateLimit: number;
}

export interface CreateApiKeyRequest {
  name: string;
  environment: ApiKeyEnvironment;
}

export interface CreatedApiKey {
  key: ApiKey;
  /** Shown to the user once. Never persisted or re-fetched. */
  secret: string;
}

/** A type alias (not an interface) so series rows are assignable to chart `Record<string, …>` props. */
export type TimePoint = { date: string };

export interface ApiUsageSummary {
  requestsToday: number;
  requestsMonth: number;
  monthlyLimit: number;
  remaining: number;
  /** 0–1. */
  errorRate: number;
  rateLimitPerMinute: number;
  series: (TimePoint & { requests: number; errors: number })[];
}

// ---------------------------------------------------------------- monitoring

export type MonitorStatus = "healthy" | "changed" | "failing" | "paused";
export type MonitorWatch = "dns" | "ip" | "provider" | "security";

export interface MonitoringRule {
  id: string;
  target: string;
  targetType: InputType;
  status: MonitorStatus;
  intervalMinutes: number;
  enabled: boolean;
  watch: MonitorWatch[];
  createdAt: string;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  /** Change counts over the last 30 days. */
  changes: Record<MonitorWatch, number>;
  lastChange?: { summary: string; at: string };
}

export interface CreateMonitorRequest {
  target: string;
  intervalMinutes: number;
  watch: MonitorWatch[];
}

export interface MonitoringOverview {
  rules: MonitoringRule[];
  limit: number | null;
}

// -------------------------------------------------------------------- alerts

export type AlertType = "dns_changed" | "ip_changed" | "security_changed" | "monitor_failed";
export type AlertSeverity = "critical" | "high" | "medium" | "low" | "info";
export type AlertCategory = "security" | "dns" | "network";

export interface Alert {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  category: AlertCategory;
  target: string;
  message: string;
  createdAt: string;
  read: boolean;
  monitorId?: string;
}

export type AlertFilter = "all" | "unread" | AlertCategory;

// ---------------------------------------------------------------- analytics

export type AnalyticsRange = "7d" | "30d" | "90d";

export interface MetricTotal {
  value: number;
  /** Change versus the previous period, as a ratio (0.12 = +12 %). */
  delta: number;
}

export interface UsageAnalytics {
  range: AnalyticsRange;
  totals: {
    totalChecks: MetricTotal;
    successfulChecks: MetricTotal;
    failedChecks: MetricTotal;
    apiRequests: MetricTotal;
    /** 0–1. */
    cacheHitRate: MetricTotal;
    providerLatencyMs: MetricTotal;
  };
  checks: (TimePoint & { successful: number; failed: number })[];
  latency: (TimePoint & Record<ProviderKey, number>)[];
  topTargets: { target: string; checks: number }[];
}

// --------------------------------------------------------------------- admin

export type UserAccountStatus = "active" | "suspended" | "pending";

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  plan: Plan;
  role: Role;
  status: UserAccountStatus;
  lastActiveAt: string;
  checks30d: number;
}

export type HealthStatus = "healthy" | "degraded" | "down";

export interface ProviderHealth {
  id: string;
  provider: string;
  role: string;
  status: HealthStatus;
  latencyMs: number;
  /** 0–1. */
  errorRate: number;
  /** Fresh provider calls in the last 15 minutes: the sample the latency and error rate come from (0 = no data yet). */
  calls: number;
  /** Set when something needs explaining, e.g. the provider isn't configured on this server. */
  detail?: string;
}

export interface SystemService {
  id: string;
  name: string;
  status: HealthStatus;
  detail: string;
  metric: { label: string; value: string };
}

/** A page of the admin user list. `total` counts every match, not just this page. */
export interface AdminUsersPage {
  users: AdminUser[];
  total: number;
}

/** What an administrator can do with an abuse flag; `reopen` undoes a block or a dismissal. */
export type AbuseDecision = "block" | "dismiss" | "reopen";

export interface AbuseFlag {
  id: string;
  subject: string;
  kind: "anonymous_session" | "ip_address" | "api_key" | "account";
  reason: string;
  severity: "low" | "medium" | "high";
  events: number;
  lastSeenAt: string;
  status: "open" | "blocked" | "dismissed";
}

export interface SubscriptionEvent {
  id: string;
  user: string;
  event: "upgraded" | "downgraded" | "canceled" | "renewed" | "payment_failed";
  plan: Plan;
  amount: number;
  at: string;
}

export interface AdminOverview {
  totals: {
    totalUsers: MetricTotal;
    activeUsers: MetricTotal;
    premiumUsers: MetricTotal;
    dailyChecks: MetricTotal;
    apiRequests: MetricTotal;
    systemErrors: MetricTotal;
  };
  mrr: number;
  planMix: { plan: Plan; users: number }[];
  dailyChecks: (TimePoint & { anonymous: number; account: number; api: number })[];
  users: AdminUser[];
  subscriptionEvents: SubscriptionEvent[];
  providers: ProviderHealth[];
  services: SystemService[];
  abuse: AbuseFlag[];
}

// -------------------------------------------------------------------- misc

export interface DashboardSummary {
  recentChecks: CheckHistory[];
  recentAlerts: Alert[];
  activeMonitors: number;
  unreadAlerts: number;
}

export interface NotificationPreferences {
  monitorAlerts: boolean;
  securityAlerts: boolean;
  weeklyDigest: boolean;
  usageWarnings: boolean;
  productUpdates: boolean;
}
