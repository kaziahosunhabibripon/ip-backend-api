import { Injectable, Logger } from '@nestjs/common';
import { ApiException } from '../common/dto/api-exception';
import { startOfNextUtcMonth } from '../common/quota';
import type {
  BillingCycle,
  ChangePlanResult,
  Invoice,
  InvoiceStatus,
  Plan,
  PlanDefinition,
  PlanQuote,
  Subscription,
  User,
} from '../contracts';
import { UsersService } from '../users/users.service';
import { BillingMailService } from './billing-mail.service';
import { RENEWAL_WINDOW_DAYS, quoteChange, type Quote } from './billing-rules';
import {
  BillingStore,
  invoiceNumber,
  toEntitlement,
  type BillingRow,
  type PaymentRow,
  type SettleOutcome,
} from './billing-store.service';
import { GatewayClient } from './gateway.client';
import { PLAN_CATALOG, isPaidPlan, unitAmountCents } from './plan-catalog';

const DAY_MS = 24 * 60 * 60_000;
const INVOICE_LIMIT = 50;
/** Unpaid invoices one customer may have open at once: enough to change their mind, not enough to flood the gateway. */
const MAX_OPEN_PAYMENTS = 3;
/** How long past an invoice's expiry we go on asking, in case it was paid at the last minute. */
const EXPIRY_GRACE_MS = 10 * 60_000;

const startOfMonth = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

const PLAN_NAMES = Object.fromEntries(
  PLAN_CATALOG.map((plan) => [plan.id, plan.name]),
) as Record<Plan, string>;

export const planName = (plan: Plan) => PLAN_NAMES[plan];

/**
 * What the billing page shows. Someone with no paid period — or whose period has ended, or an Enterprise plan
 * arranged by hand — is on Free (or Enterprise) for the calendar month, the same window their usage counts in.
 */
export const toSubscriptionView = (
  user: Pick<User, 'id' | 'plan'>,
  row: BillingRow | undefined,
  pending: PaymentRow | undefined,
  now = new Date(),
): Subscription => {
  const pendingPayment = pending
    ? {
        id: pending.id,
        plan: pending.plan,
        billingCycle: pending.billingCycle as BillingCycle,
        amount: pending.amountCents / 100,
        checkoutUrl: pending.checkoutUrl ?? '',
        expiresAt: pending.expiresAt?.toISOString() ?? null,
      }
    : null;

  const entitlement = toEntitlement(row);
  if (
    !entitlement ||
    entitlement.periodEnd <= now ||
    user.plan === 'enterprise'
  ) {
    return {
      id: `plan_${user.id}`,
      plan: user.plan,
      status: 'active',
      billingCycle: 'monthly',
      currentPeriodStart: startOfMonth(now).toISOString(),
      currentPeriodEnd: startOfNextUtcMonth(now).toISOString(),
      amount: 0,
      renewalDue: false,
      queued: null,
      pendingPayment,
    };
  }

  return {
    id: row?.id ?? `plan_${user.id}`,
    plan: entitlement.plan,
    status: 'active',
    billingCycle: entitlement.cycle,
    currentPeriodStart: entitlement.periodStart.toISOString(),
    currentPeriodEnd: entitlement.periodEnd.toISOString(),
    amount:
      unitAmountCents(
        entitlement.plan as 'pro' | 'business',
        entitlement.cycle,
      ) / 100,
    renewalDue:
      entitlement.periodEnd.getTime() - now.getTime() <=
      RENEWAL_WINDOW_DAYS * DAY_MS,
    queued: entitlement.queued
      ? {
          plan: entitlement.queued.plan,
          billingCycle: entitlement.queued.cycle,
        }
      : null,
    pendingPayment,
  };
};

const describeKind = (payment: PaymentRow): string => {
  const length = payment.billingCycle === 'annual' ? '1 year' : '30 days';
  const base = `IPScope ${planName(payment.plan)}, ${length}`;
  switch (payment.kind) {
    case 'renewal':
      return `${base} (renewal)`;
    case 'upgrade':
      return `${base} (upgrade${payment.creditCents > 0 ? `, $${(payment.creditCents / 100).toFixed(2)} credit for unused days` : ''})`;
    case 'queue':
      return `${base} (starts when your current plan ends)`;
    default:
      return base;
  }
};

const INVOICE_STATUS: Record<string, InvoiceStatus> = {
  pending: 'open',
  paid: 'paid',
  failed: 'failed',
  expired: 'failed',
  refunded: 'refunded',
};

export const toInvoiceView = (
  payment: PaymentRow,
  now = new Date(),
): Invoice => ({
  id: payment.id,
  number: invoiceNumber(payment.seq),
  issuedAt: payment.createdAt.toISOString(),
  description: describeKind(payment),
  amount: payment.amountCents / 100,
  status: INVOICE_STATUS[payment.status] ?? 'failed',
  // The one thing to do with an open invoice is pay it; nothing else has a page to link to.
  hostedUrl:
    payment.status === 'pending' && payment.expiresAt && payment.expiresAt > now
      ? payment.checkoutUrl
      : null,
});

export const toQuoteView = (quote: Quote): PlanQuote =>
  quote.kind === 'none'
    ? { kind: 'none', amount: 0, credit: 0, listPrice: 0, startsAt: null }
    : {
        kind: quote.kind,
        amount: quote.amountCents / 100,
        credit: quote.creditCents / 100,
        listPrice: quote.listPriceCents / 100,
        startsAt: quote.startsAt.toISOString(),
      };

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  /** A double click on "Confirm" must not open two invoices. */
  private readonly changing = new Map<string, Promise<ChangePlanResult>>();

  constructor(
    private readonly gateway: GatewayClient,
    private readonly store: BillingStore,
    private readonly users: UsersService,
    private readonly mail: BillingMailService,
  ) {}

  plans(): PlanDefinition[] {
    return PLAN_CATALOG;
  }

  async subscription(user: User, now = new Date()): Promise<Subscription> {
    const [row, pending] = await Promise.all([
      this.store.getByUser(user.id),
      this.store.pendingFor(user.id, now),
    ]);
    return toSubscriptionView(user, row, pending[0], now);
  }

  async invoices(user: User, now = new Date()): Promise<Invoice[]> {
    const rows = await this.store.listPayments(user.id, INVOICE_LIMIT);
    return rows.map((row) => toInvoiceView(row, now));
  }

  /** What choosing this plan would cost, without opening anything. Free of the gateway, so it works when billing is off. */
  async quote(
    user: User,
    target: { plan: Plan; billingCycle: BillingCycle },
    now = new Date(),
  ): Promise<PlanQuote> {
    const row = await this.store.getByUser(user.id);
    return toQuoteView(
      quoteChange(
        toEntitlement(row),
        { plan: target.plan, cycle: target.billingCycle },
        now,
      ),
    );
  }

  changePlan(
    user: User,
    target: { plan: Plan; billingCycle: BillingCycle },
  ): Promise<ChangePlanResult> {
    const key = `${user.id}|${target.plan}|${target.billingCycle}`;
    const running = this.changing.get(key);
    if (running) {
      return running;
    }
    const work = this.applyChange(user, target).finally(() =>
      this.changing.delete(key),
    );
    this.changing.set(key, work);
    return work;
  }

  /**
   * Asks the gateway about this customer's open invoices right now. The scheduler does the same on its own; the
   * billing page calls this when a customer returns from paying, so they don't wait for the next round.
   */
  async refresh(user: User, now = new Date()): Promise<Subscription> {
    if (this.gateway.enabled) {
      const pending = await this.store.pendingFor(user.id, now);
      for (const payment of pending.slice(0, MAX_OPEN_PAYMENTS)) {
        try {
          await this.check(payment, now);
        } catch (error) {
          // The page still shows what it has; the scheduler will ask again.
          this.logger.warn(
            `Could not check payment ${payment.id} for ${user.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    return this.subscription(user, now);
  }

  /**
   * A signed message from the gateway that an invoice changed. It is only a nudge: we ask the gateway what the
   * invoice looks like now and act on that, so a forged, replayed or out-of-order message can't change anything.
   */
  async handleWebhook(
    rawBody: Buffer | undefined,
    signature: string | undefined,
    now = new Date(),
  ): Promise<void> {
    if (!this.gateway.enabled || !this.gateway.webhookSecret) {
      throw new ApiException(
        'PROVIDER_UNAVAILABLE',
        "Payment webhooks aren't enabled here.",
      );
    }
    const invoiceNo = this.gateway.verifyWebhook(rawBody, signature);
    if (!invoiceNo) {
      throw new ApiException('INVALID_INPUT', 'Invalid webhook signature.');
    }

    const payment = await this.store.findByInvoiceNo(invoiceNo);
    if (!payment) {
      return; // an invoice on our payment link that isn't ours
    }
    await this.check(payment, now);
  }

  /** Asks the gateway about one payment and applies the answer. Throws if the gateway can't be asked. */
  async check(payment: PaymentRow, now = new Date()): Promise<SettleOutcome> {
    const invoice = await this.gateway.getInvoice(payment.gatewayInvoiceNo);
    const result = await this.store.settle(payment.id, invoice, now);

    if (result.outcome === 'granted') {
      void this.announce(result.userId, payment);
    } else if (result.outcome === 'still_pending') {
      const overdue =
        payment.expiresAt &&
        now.getTime() > payment.expiresAt.getTime() + EXPIRY_GRACE_MS;
      if (overdue) {
        await this.store.expire(payment.id, now);
      } else {
        await this.store.schedulePoll(
          payment.id,
          payment.pollAttempts + 1,
          now,
        );
      }
    }
    return result;
  }

  // ---------------------------------------------------------------- changing plan

  private async applyChange(
    user: User,
    target: { plan: Plan; billingCycle: BillingCycle },
  ): Promise<ChangePlanResult> {
    if (user.plan === 'enterprise') {
      throw new ApiException(
        'CONFLICT',
        'Your Enterprise plan is managed by our team. Contact sales to change it.',
      );
    }
    const now = new Date();

    // Free means "don't renew": there is nothing to buy, and a paid period simply runs out.
    if (!isPaidPlan(target.plan)) {
      return {
        subscription: await this.subscription(user, now),
        checkoutUrl: null,
      };
    }
    this.gateway.require();

    const [row, open] = await Promise.all([
      this.store.getByUser(user.id),
      this.store.pendingFor(user.id, now),
    ]);
    const entitlement = toEntitlement(row);
    const quote = quoteChange(
      entitlement,
      { plan: target.plan, cycle: target.billingCycle },
      now,
    );
    if (quote.kind === 'none') {
      return {
        subscription: await this.subscription(user, now),
        checkoutUrl: null,
      };
    }

    if (quote.kind === 'queue' && entitlement?.queued) {
      throw new ApiException(
        'CONFLICT',
        `You already have ${planName(entitlement.queued.plan)} paid for after this period.`,
      );
    }

    // The same invoice is still open: send them back to it instead of opening another.
    const same = open.find(
      (payment) =>
        payment.plan === target.plan &&
        payment.billingCycle === target.billingCycle &&
        payment.kind === quote.kind &&
        payment.amountCents === quote.amountCents &&
        payment.checkoutUrl,
    );
    if (same) {
      return {
        subscription: toSubscriptionView(user, row, same, now),
        checkoutUrl: same.checkoutUrl,
      };
    }
    if (open.length >= MAX_OPEN_PAYMENTS) {
      throw new ApiException(
        'CONFLICT',
        'You have several unpaid invoices open. Pay one, or wait for them to expire, before starting another.',
      );
    }

    const invoice = await this.gateway.createInvoice(
      quote.amountCents,
      `${this.gateway.webUrl}/billing?checkout=success`,
    );
    if (!invoice.checkoutUrl) {
      this.logger.error(
        `The gateway opened invoice ${invoice.invoiceNo} without a checkout URL.`,
      );
      throw new ApiException(
        'PROVIDER_UNAVAILABLE',
        "Payments aren't available right now. Please try again shortly.",
      );
    }

    const payment = await this.store.createPayment({
      userId: user.id,
      plan: target.plan,
      billingCycle: target.billingCycle,
      kind: quote.kind,
      amountCents: quote.amountCents,
      creditCents: quote.creditCents,
      listPriceCents: quote.listPriceCents,
      invoice,
      now,
    });
    return {
      subscription: toSubscriptionView(user, row, payment, now),
      checkoutUrl: invoice.checkoutUrl,
    };
  }

  /** Tells the customer their payment landed. Best-effort: it never fails a settlement. */
  private async announce(userId: string, payment: PaymentRow): Promise<void> {
    try {
      const [user, row] = await Promise.all([
        this.users.findById(userId),
        this.store.getByUser(userId),
      ]);
      if (user && row?.currentPeriodEnd) {
        await this.mail.sendReceipt(user, {
          planName: planName(payment.plan),
          amountCents: payment.amountCents,
          coveredUntil: row.currentPeriodEnd,
          queued: payment.kind === 'queue',
        });
      }
    } catch (error) {
      this.logger.warn(
        `Could not send a receipt for payment ${payment.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
