export type Plan = "free" | "pro" | "business" | "enterprise";
/** A viewer's tier for gating purposes; signed-out visitors are `anonymous`. */
export type Tier = "anonymous" | Plan;
export type Role = "user" | "admin";

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** What this account has paid for. Billing and account pages always show this one, never `effectivePlan`. */
  plan: Plan;
  /**
   * What this account may actually use right now: `plan`, or — while it's an active member of someone else's
   * team — that team owner's plan, if higher. Every feature gate and quota limit goes by this one.
   */
  effectivePlan: Plan;
  emailVerified: boolean;
  createdAt: string;
}

export interface LoginCredentials {
  email: string;
  password: string;
  remember?: boolean;
}

export interface SignupPayload {
  name: string;
  email: string;
  password: string;
}

export interface SessionInfo {
  id: string;
  device: string;
  location: string;
  lastActiveAt: string;
  current: boolean;
}

// ------------------------------------------------------------------ billing

export type BillingCycle = "monthly" | "annual";

export interface PlanDefinition {
  id: Plan;
  name: string;
  tagline: string;
  /** Null means "talk to sales". */
  priceMonthly: number | null;
  /** Effective per-month price when billed annually. */
  priceAnnualMonthly: number | null;
  highlighted?: boolean;
  badge?: string;
  cta: string;
  /** Marketing bullets shown on the plan card. */
  features: string[];
  limits: PlanLimits;
}

export interface PlanLimits {
  lookups: number | null;
  lookupPeriod: "month";
  apiRequests: number | null;
  monitors: number | null;
  bulkBatchSize: number | null;
  /** Seats a team may hold, the owner not counted. 0 when the plan has no team workspace, null when negotiated. */
  teamSeats: number | null;
}

export type SubscriptionStatus = "active" | "trialing" | "past_due" | "canceled";

/** A plan paid for in advance that begins when the current period ends. */
export interface QueuedPlan {
  plan: Plan;
  billingCycle: BillingCycle;
}

/** An invoice the customer has been sent to pay and hasn't yet. */
export interface PendingPayment {
  id: string;
  plan: Plan;
  billingCycle: BillingCycle;
  /** What it charges, in USD. */
  amount: number;
  /** The payment gateway's hosted checkout for it. */
  checkoutUrl: string;
  expiresAt: string | null;
}

/**
 * Plans are paid for a period at a time (30 days, or 365 at the annual price) and never renew by themselves:
 * when `currentPeriodEnd` passes, the account is on Free unless the customer paid again first.
 */
export interface Subscription {
  id: string;
  plan: Plan;
  status: SubscriptionStatus;
  billingCycle: BillingCycle;
  currentPeriodStart: string;
  /** When the paid period ends (paid plans), or the end of the calendar month the free allowance counts in. */
  currentPeriodEnd: string;
  /** The price of one period, in USD. 0 on Free. */
  amount: number;
  /** True in the last 7 days of a paid period: time to renew. */
  renewalDue: boolean;
  queued: QueuedPlan | null;
  pendingPayment: PendingPayment | null;
}

export type InvoiceStatus = "paid" | "open" | "failed" | "refunded";

export interface Invoice {
  id: string;
  number: string;
  issuedAt: string;
  description: string;
  amount: number;
  status: InvoiceStatus;
  /** The payment provider's hosted page for the invoice (it links the PDF). Null when there isn't one. */
  hostedUrl: string | null;
}

export interface UsageMeter {
  used: number;
  /** Null means unlimited / custom. */
  limit: number | null;
}

export interface Usage {
  lookups: UsageMeter;
  apiRequests: UsageMeter;
  monitors: UsageMeter;
  periodStart: string;
  periodEnd: string;
}

export interface ChangePlanRequest {
  plan: Plan;
  billingCycle: BillingCycle;
}

/**
 * Choosing a paid plan always means paying: `checkoutUrl` is the payment gateway's hosted checkout, the site sends
 * the customer there, and the plan changes once the payment is confirmed (the billing page asks for that when they
 * come back). `checkoutUrl` is null when there is nothing to pay for — choosing Free just means not renewing.
 */
export interface ChangePlanResult {
  subscription: Subscription | null;
  checkoutUrl: string | null;
}

/**
 * What a plan choice would cost, worked out before anything is opened:
 * - `purchase`: nothing is paid for now, so the plan starts on payment;
 * - `renewal`: the same plan again, added after the current period;
 * - `upgrade`: a bigger plan replaces the current one at once, less a credit for its unused days;
 * - `queue`: a smaller plan is bought now and starts when the current period ends (no refund).
 */
export interface PlanQuote {
  kind: "purchase" | "renewal" | "upgrade" | "queue" | "none";
  /** What the invoice charges, in USD. */
  amount: number;
  /** What was taken off for unused days, in USD. */
  credit: number;
  /** The plan's price for the cycle, in USD. */
  listPrice: number;
  /** When the new period begins. Null when `kind` is "none". */
  startsAt: string | null;
}
