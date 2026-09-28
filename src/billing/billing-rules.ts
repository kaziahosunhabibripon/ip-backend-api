import { PLAN_ORDER } from '../common/plans';
import type { BillingCycle, Plan } from '../contracts';
import { isPaidPlan, unitAmountCents } from './plan-catalog';

/**
 * How paying works: a customer buys a *period* of a plan up front (30 days, or 365 for the annual price) through
 * the payment gateway. Nothing is charged automatically: when the period ends the plan lapses to Free unless it
 * was renewed. Everything in this file is the pure arithmetic of that — no clock, no database, no gateway.
 */
export const PERIOD_DAYS: Record<BillingCycle, number> = {
  monthly: 30,
  annual: 365,
};

const DAY_MS = 24 * 60 * 60_000;

/** The gateway won't take a payment of nothing, and a tiny one costs more to settle than it is worth. */
export const MIN_CHARGE_CENTS = 100;

/** How long before a period ends the customer is reminded, and offered a renewal. */
export const RENEWAL_WINDOW_DAYS = 7;

export const addDays = (from: Date, days: number): Date =>
  new Date(from.getTime() + days * DAY_MS);

/** What a user has paid for. `paidCents` is the list price of the whole span, so unused time can be credited. */
export interface Entitlement {
  plan: Plan;
  cycle: BillingCycle;
  periodStart: Date;
  periodEnd: Date;
  paidCents: number;
  /** Bought already, starts when this period ends. */
  queued: { plan: Plan; cycle: BillingCycle } | null;
}

export interface Target {
  plan: Plan;
  cycle: BillingCycle;
}

export const isActive = (
  entitlement: Entitlement | null | undefined,
  now: Date,
): entitlement is Entitlement =>
  Boolean(
    entitlement &&
    entitlement.plan !== 'free' &&
    entitlement.periodEnd.getTime() > now.getTime(),
  );

const rank = (plan: Plan) => PLAN_ORDER.indexOf(plan);

/** Money for the days left of what was paid: proportional to the time remaining, never more than was paid. */
export const creditCents = (entitlement: Entitlement, now: Date): number => {
  const total =
    entitlement.periodEnd.getTime() - entitlement.periodStart.getTime();
  const left = Math.max(0, entitlement.periodEnd.getTime() - now.getTime());
  if (total <= 0 || left <= 0) {
    return 0;
  }
  return Math.min(
    entitlement.paidCents,
    Math.floor((entitlement.paidCents * left) / total),
  );
};

/**
 * What a payment does:
 * - `purchase`: nothing paid for right now, so a new period starts on payment;
 * - `renewal`: the same plan again — the new period is added after the current one;
 * - `upgrade`: a bigger plan (or the annual price of the same one) replaces the current one at once, and the unused
 *   days of what was paid are taken off the price;
 * - `queue`: a smaller plan (or the monthly price of the same one) is bought now and starts when the current period
 *   ends — the current plan keeps running, and nothing is refunded.
 */
export type ChargeKind = 'purchase' | 'renewal' | 'upgrade' | 'queue';

export type Quote =
  | {
      kind: ChargeKind;
      /** What the gateway invoice will charge. */
      amountCents: number;
      creditCents: number;
      /** What the new period is worth at list price. */
      listPriceCents: number;
      /** When the new period begins: now, or the end of the current one. */
      startsAt: Date;
    }
  | { kind: 'none' };

export const quoteChange = (
  current: Entitlement | null | undefined,
  target: Target,
  now: Date,
): Quote => {
  if (!isPaidPlan(target.plan)) {
    return { kind: 'none' };
  }
  const listPriceCents = unitAmountCents(target.plan, target.cycle);

  if (!isActive(current, now)) {
    return {
      kind: 'purchase',
      amountCents: listPriceCents,
      creditCents: 0,
      listPriceCents,
      startsAt: now,
    };
  }

  if (current.plan === target.plan && current.cycle === target.cycle) {
    return {
      kind: 'renewal',
      amountCents: listPriceCents,
      creditCents: 0,
      listPriceCents,
      startsAt: current.periodEnd,
    };
  }

  const bigger =
    rank(target.plan) > rank(current.plan) ||
    (target.plan === current.plan &&
      current.cycle === 'monthly' &&
      target.cycle === 'annual');
  if (bigger) {
    const credit = creditCents(current, now);
    return {
      kind: 'upgrade',
      amountCents: Math.max(MIN_CHARGE_CENTS, listPriceCents - credit),
      creditCents: Math.min(
        credit,
        Math.max(0, listPriceCents - MIN_CHARGE_CENTS),
      ),
      listPriceCents,
      startsAt: now,
    };
  }

  return {
    kind: 'queue',
    amountCents: listPriceCents,
    creditCents: 0,
    listPriceCents,
    startsAt: current.periodEnd,
  };
};

export type PlanEventKind = 'upgraded' | 'downgraded' | 'canceled';

/**
 * What a change in the plan a customer is *on* (not the one they asked for) means for the admin feed. Moving
 * to a bigger plan is an upgrade — including the first purchase — to a smaller paid plan a downgrade, and
 * ending up on Free means the paid period ended. Null when nothing changed.
 */
export const planEventKind = (
  before: Plan,
  after: Plan,
): PlanEventKind | null => {
  if (before === after) {
    return null;
  }
  if (after === 'free') {
    return 'canceled';
  }
  return rank(after) > rank(before) ? 'upgraded' : 'downgraded';
};

export type Grant = 'started' | 'extended' | 'switched' | 'queued';

/**
 * Gives a paid payment its effect. It looks at what the user has *now*, not at what they had when they clicked,
 * so paying an old invoice late, or two at once, always ends up somewhere sensible instead of double-granting:
 * the same plan again extends, a bigger one switches at once, a smaller one waits its turn.
 */
export const applyPayment = (
  current: Entitlement | null | undefined,
  paid: Target & { listPriceCents: number },
  now: Date,
): { entitlement: Entitlement; grant: Grant } => {
  const fresh = (): Entitlement => ({
    plan: paid.plan,
    cycle: paid.cycle,
    periodStart: now,
    periodEnd: addDays(now, PERIOD_DAYS[paid.cycle]),
    paidCents: paid.listPriceCents,
    queued: current && isActive(current, now) ? current.queued : null,
  });

  if (!isActive(current, now)) {
    return { entitlement: { ...fresh(), queued: null }, grant: 'started' };
  }

  if (current.plan === paid.plan && current.cycle === paid.cycle) {
    return {
      entitlement: {
        ...current,
        periodEnd: addDays(current.periodEnd, PERIOD_DAYS[paid.cycle]),
        paidCents: current.paidCents + paid.listPriceCents,
      },
      grant: 'extended',
    };
  }

  const bigger =
    rank(paid.plan) > rank(current.plan) ||
    (paid.plan === current.plan &&
      current.cycle === 'monthly' &&
      paid.cycle === 'annual');
  if (bigger) {
    return { entitlement: fresh(), grant: 'switched' };
  }

  return {
    entitlement: {
      ...current,
      queued: { plan: paid.plan, cycle: paid.cycle },
    },
    grant: 'queued',
  };
};

/**
 * What happens to an entitlement whose period has ended: the plan bought in advance starts, or — with none — the
 * user is back on Free (`null`). If the job ran late and the queued period is over too, it keeps going.
 */
export const roll = (current: Entitlement, now: Date): Entitlement | null => {
  let entitlement: Entitlement = current;
  for (;;) {
    if (entitlement.periodEnd.getTime() > now.getTime()) {
      return entitlement;
    }
    const next = entitlement.queued;
    if (!next) {
      return null;
    }
    const start = entitlement.periodEnd;
    entitlement = {
      plan: next.plan,
      cycle: next.cycle,
      periodStart: start,
      periodEnd: addDays(start, PERIOD_DAYS[next.cycle]),
      paidCents: isPaidPlan(next.plan)
        ? unitAmountCents(next.plan, next.cycle)
        : 0,
      queued: null,
    };
  }
};
