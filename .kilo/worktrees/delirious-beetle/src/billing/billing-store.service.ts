import { Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  ne,
  or,
  sql,
  type InferSelectModel,
} from 'drizzle-orm';
import type { BillingCycle, Plan } from '../contracts';
import type { Database } from '../db/database';
import {
  payments,
  subscriptionEvents,
  subscriptions,
  users,
} from '../db/schema';
import {
  applyPayment,
  planEventKind,
  roll,
  type Entitlement,
  type Grant,
} from './billing-rules';
import type { GatewayInvoice } from './gateway.client';
import { isPaidPlan, unitAmountCents } from './plan-catalog';

export type BillingRow = InferSelectModel<typeof subscriptions>;
export type PaymentRow = InferSelectModel<typeof payments>;
export type PaymentStatus =
  'pending' | 'paid' | 'failed' | 'expired' | 'refunded';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** The number people see on an invoice. */
export const invoiceNumber = (seq: number) =>
  `IPS-${String(seq).padStart(5, '0')}`;

/** What a subscription row says a user has paid for, or null when they are on Free. */
export const toEntitlement = (
  row: BillingRow | undefined | null,
): Entitlement | null => {
  if (
    !row ||
    row.plan === 'free' ||
    !row.currentPeriodStart ||
    !row.currentPeriodEnd
  ) {
    return null;
  }
  return {
    plan: row.plan,
    cycle: row.billingCycle as BillingCycle,
    periodStart: row.currentPeriodStart,
    periodEnd: row.currentPeriodEnd,
    paidCents: row.amountCents,
    queued:
      row.queuedPlan && row.queuedCycle
        ? { plan: row.queuedPlan, cycle: row.queuedCycle as BillingCycle }
        : null,
  };
};

export type SettleOutcome =
  | { outcome: 'granted'; grant: Grant; userId: string }
  | {
      outcome:
        | 'already'
        | 'still_pending'
        | 'failed'
        | 'refunded'
        | 'mismatch'
        | 'not_found';
    };

/** Seconds to wait before asking the gateway about a payment again: quick at first, then backing off. */
export const pollDelaySeconds = (attempts: number): number =>
  [15, 30, 60, 120, 300][Math.min(attempts, 4)];

/**
 * Database access for billing, and the one place a payment becomes a plan. `settle` is the money-critical
 * step: it takes a lock on the payment, checks it wasn't already applied and that the amount is what we asked
 * for, and only then grants the period — all in one transaction, so a webhook and a poll arriving together
 * (or the same one twice) can never grant it twice.
 */
@Injectable()
export class BillingStore {
  private readonly logger = new Logger(BillingStore.name);

  constructor(@InjectDrizzle() private readonly db: Database) {}

  async getByUser(userId: string): Promise<BillingRow | undefined> {
    const [row] = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .limit(1);
    return row;
  }

  // ------------------------------------------------------------------ payments

  async createPayment(input: {
    userId: string;
    plan: Plan;
    billingCycle: BillingCycle;
    kind: string;
    amountCents: number;
    creditCents: number;
    listPriceCents: number;
    invoice: GatewayInvoice;
    now: Date;
  }): Promise<PaymentRow> {
    const [row] = await this.db
      .insert(payments)
      .values({
        userId: input.userId,
        plan: input.plan,
        billingCycle: input.billingCycle,
        kind: input.kind,
        amountCents: input.amountCents,
        creditCents: input.creditCents,
        listPriceCents: input.listPriceCents,
        gatewayInvoiceNo: input.invoice.invoiceNo,
        checkoutUrl: input.invoice.checkoutUrl,
        // An invoice with no stated expiry is given a day, so a payment nobody completes can't be polled forever.
        expiresAt:
          input.invoice.expiresAt ??
          new Date(input.now.getTime() + 24 * 60 * 60_000),
        createdAt: input.now,
        nextPollAt: new Date(input.now.getTime() + pollDelaySeconds(0) * 1000),
      })
      .returning();
    return row;
  }

  async getPayment(id: string): Promise<PaymentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(payments)
      .where(eq(payments.id, id))
      .limit(1);
    return row;
  }

  async findByInvoiceNo(invoiceNo: string): Promise<PaymentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(payments)
      .where(eq(payments.gatewayInvoiceNo, invoiceNo))
      .limit(1);
    return row;
  }

  /** Payments still waiting on the customer, newest first — the ones the billing page offers to resume. */
  pendingFor(userId: string, now: Date): Promise<PaymentRow[]> {
    return this.db
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.userId, userId),
          eq(payments.status, 'pending'),
          sql`${payments.expiresAt} > ${now.toISOString()}::timestamp`,
        ),
      )
      .orderBy(desc(payments.createdAt));
  }

  listPayments(userId: string, limit: number): Promise<PaymentRow[]> {
    return this.db
      .select()
      .from(payments)
      .where(eq(payments.userId, userId))
      .orderBy(desc(payments.createdAt), desc(payments.seq))
      .limit(limit);
  }

  /**
   * Takes the payments that are due to be asked about, and pushes each one's next poll a minute out as a lease, so
   * another instance (or the next tick) doesn't ask about the same ones at the same time.
   */
  claimDuePolls(now: Date, limit: number): Promise<PaymentRow[]> {
    return this.db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(payments)
        .where(
          and(eq(payments.status, 'pending'), lte(payments.nextPollAt, now)),
        )
        .orderBy(asc(payments.nextPollAt), asc(payments.id))
        .limit(limit)
        .for('update', { skipLocked: true });

      if (due.length > 0) {
        await tx
          .update(payments)
          .set({ nextPollAt: new Date(now.getTime() + 60_000) })
          .where(
            inArray(
              payments.id,
              due.map((row) => row.id),
            ),
          );
      }
      return due;
    });
  }

  /** After asking and finding it still pending: when to ask next. */
  async schedulePoll(id: string, attempts: number, now: Date): Promise<void> {
    await this.db
      .update(payments)
      .set({
        pollAttempts: attempts,
        nextPollAt: new Date(now.getTime() + pollDelaySeconds(attempts) * 1000),
      })
      .where(and(eq(payments.id, id), eq(payments.status, 'pending')));
  }

  /** A payment nobody completed before it expired. It stays open to a late "paid" from the gateway: `settle` still honours that. */
  async expire(id: string, now: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(payments)
        .set({ status: 'expired' })
        .where(and(eq(payments.id, id), eq(payments.status, 'pending')))
        .returning();
      if (row) {
        await this.recordFailure(tx, row, now);
      }
    });
  }

  // ------------------------------------------------------------------ settling

  async settle(
    paymentId: string,
    invoice: GatewayInvoice,
    now: Date,
  ): Promise<SettleOutcome> {
    return this.db.transaction(async (tx) => {
      const [payment] = await tx
        .select()
        .from(payments)
        .where(eq(payments.id, paymentId))
        .for('update')
        .limit(1);
      if (!payment) {
        return { outcome: 'not_found' };
      }

      switch (invoice.status) {
        case 'pending':
          return { outcome: 'still_pending' };

        case 'paid': {
          if (payment.appliedAt) {
            return { outcome: 'already' };
          }
          if (invoice.amountCents !== payment.amountCents) {
            // Never trust the far side's number over our own record: someone paid a different amount than we asked.
            this.logger.error(
              `Payment ${payment.id} (invoice ${payment.gatewayInvoiceNo}) was paid as ${invoice.amountCents} cents but asked ${payment.amountCents}. Not applied; needs a person to look at it.`,
            );
            await tx
              .update(payments)
              .set({ status: 'failed' })
              .where(eq(payments.id, payment.id));
            return { outcome: 'mismatch' };
          }
          const grant = await this.grant(tx, payment, now);
          return { outcome: 'granted', grant, userId: payment.userId };
        }

        case 'refunded': {
          if (payment.status === 'refunded') {
            return { outcome: 'already' };
          }
          await tx
            .update(payments)
            .set({ status: 'refunded' })
            .where(eq(payments.id, payment.id));
          // A refunded period is not a period paid for: whatever it bought ends now.
          if (payment.appliedAt) {
            await this.endPlan(tx, payment.userId, now);
          }
          return { outcome: 'refunded' };
        }

        default: {
          // expired | failed | cancelled — it will never be paid.
          if (payment.status === 'pending') {
            const [row] = await tx
              .update(payments)
              .set({
                status: invoice.status === 'expired' ? 'expired' : 'failed',
              })
              .where(eq(payments.id, payment.id))
              .returning();
            await this.recordFailure(tx, row, now);
          }
          return { outcome: 'failed' };
        }
      }
    });
  }

  /** Gives a paid payment its effect on the user's plan and marks it applied — inside the caller's transaction. */
  private async grant(tx: Tx, payment: PaymentRow, now: Date): Promise<Grant> {
    await tx
      .insert(subscriptions)
      .values({ userId: payment.userId, plan: 'free', billingCycle: 'monthly' })
      .onConflictDoNothing({ target: subscriptions.userId });
    const [row] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, payment.userId))
      .for('update')
      .limit(1);

    const before = toEntitlement(row);
    const { entitlement, grant } = applyPayment(
      before,
      {
        plan: payment.plan,
        cycle: payment.billingCycle as BillingCycle,
        listPriceCents: payment.listPriceCents,
      },
      now,
    );
    await this.write(tx, payment.userId, entitlement, now);

    await tx
      .update(payments)
      .set({ status: 'paid', paidAt: now, appliedAt: now })
      .where(eq(payments.id, payment.id));

    const kind =
      grant === 'extended'
        ? 'renewed'
        : planEventKind(before?.plan ?? 'free', entitlement.plan);
    if (kind && grant !== 'queued') {
      await tx
        .insert(subscriptionEvents)
        .values({
          userId: payment.userId,
          kind,
          plan: entitlement.plan,
          fromPlan: before?.plan ?? 'free',
          amountCents: payment.listPriceCents,
          dedupeKey: `payment:${payment.id}:${kind}`,
          at: now,
        })
        .onConflictDoNothing({ target: subscriptionEvents.dedupeKey });
    }
    return grant;
  }

  private async recordFailure(
    tx: Tx,
    payment: PaymentRow,
    now: Date,
  ): Promise<void> {
    await tx
      .insert(subscriptionEvents)
      .values({
        userId: payment.userId,
        kind: 'payment_failed',
        plan: payment.plan,
        amountCents: payment.amountCents,
        dedupeKey: `payment:${payment.id}:failed`,
        at: now,
      })
      .onConflictDoNothing({ target: subscriptionEvents.dedupeKey });
  }

  /** Ends the paid plan at once (a refund), whatever was queued behind it. */
  private async endPlan(tx: Tx, userId: string, now: Date): Promise<void> {
    const [row] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .for('update')
      .limit(1);
    const before = toEntitlement(row);
    if (!before) {
      return;
    }
    await this.write(tx, userId, null, now);
    await tx.insert(subscriptionEvents).values({
      userId,
      kind: 'canceled',
      plan: before.plan,
      fromPlan: before.plan,
      amountCents: unitAmountCentsOf(before.plan, before.cycle),
      at: now,
    });
  }

  /** Writes what a user has paid for (or, with null, that they are back on Free) and moves `users.plan` with it. */
  private async write(
    tx: Tx,
    userId: string,
    entitlement: Entitlement | null,
    now: Date,
  ): Promise<void> {
    if (entitlement) {
      await tx
        .update(subscriptions)
        .set({
          plan: entitlement.plan,
          billingCycle: entitlement.cycle,
          status: 'active',
          currentPeriodStart: entitlement.periodStart,
          currentPeriodEnd: entitlement.periodEnd,
          amountCents: entitlement.paidCents,
          queuedPlan: entitlement.queued?.plan ?? null,
          queuedCycle: entitlement.queued?.cycle ?? null,
          syncedAt: now,
        })
        .where(eq(subscriptions.userId, userId));
    } else {
      await tx
        .update(subscriptions)
        .set({
          plan: 'free',
          status: 'expired',
          queuedPlan: null,
          queuedCycle: null,
          syncedAt: now,
        })
        .where(eq(subscriptions.userId, userId));
    }

    // A hand-arranged Enterprise plan is not sold here and is never touched.
    await tx
      .update(users)
      .set({ plan: entitlement?.plan ?? 'free' })
      .where(and(eq(users.id, userId), ne(users.plan, 'enterprise')));
  }

  // ------------------------------------------------------------------ lapsing

  /**
   * Moves on every user whose paid period has ended: the plan bought in advance starts, or they go back to Free.
   * Rows are taken with `SKIP LOCKED`, so several instances can run this and each user is handled once.
   */
  async rollExpired(
    now: Date,
    limit: number,
  ): Promise<{ userId: string; from: Plan; to: Plan }[]> {
    return this.db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(subscriptions)
        .where(
          and(
            ne(subscriptions.plan, 'free'),
            isNotNull(subscriptions.currentPeriodEnd),
            lte(subscriptions.currentPeriodEnd, now),
          ),
        )
        .orderBy(asc(subscriptions.currentPeriodEnd), asc(subscriptions.id))
        .limit(limit)
        .for('update', { skipLocked: true });

      const moves: { userId: string; from: Plan; to: Plan }[] = [];
      for (const row of due) {
        const before = toEntitlement(row);
        if (!before) {
          continue;
        }
        const after = roll(before, now);
        await this.write(tx, row.userId, after, now);

        const kind = planEventKind(before.plan, after?.plan ?? 'free');
        if (kind) {
          await tx.insert(subscriptionEvents).values({
            userId: row.userId,
            kind,
            plan: kind === 'canceled' ? before.plan : (after?.plan ?? 'free'),
            fromPlan: before.plan,
            amountCents:
              kind === 'canceled'
                ? unitAmountCentsOf(before.plan, before.cycle)
                : after
                  ? unitAmountCentsOf(after.plan, after.cycle)
                  : 0,
            at: now,
          });
        }
        moves.push({
          userId: row.userId,
          from: before.plan,
          to: after?.plan ?? 'free',
        });
      }
      return moves;
    });
  }

  // ------------------------------------------------------------------ reminders

  /** Rows whose paid period ends within `withinMs`, for the reminder job to look at. */
  endingWithin(
    now: Date,
    withinMs: number,
    limit: number,
  ): Promise<BillingRow[]> {
    return this.db
      .select()
      .from(subscriptions)
      .where(
        and(
          ne(subscriptions.plan, 'free'),
          isNotNull(subscriptions.currentPeriodEnd),
          sql`${subscriptions.currentPeriodEnd} > ${now.toISOString()}::timestamp`,
          lte(
            subscriptions.currentPeriodEnd,
            new Date(now.getTime() + withinMs),
          ),
        ),
      )
      .orderBy(asc(subscriptions.currentPeriodEnd))
      .limit(limit);
  }

  /** Paid plans that lapsed since `since` and whose owner hasn't been told. */
  lapsedUnnotified(
    now: Date,
    since: Date,
    limit: number,
  ): Promise<{ row: BillingRow; endedPlan: Plan | null }[]> {
    return this.db
      .select({
        row: subscriptions,
        // The row itself is Free by now; the plan that ended is in the event written when it did. The outer column is
        // named in full: in a one-table select drizzle leaves it bare, and inside the subquery a bare `user_id`
        // would mean the event's own — matching every event, so whoever's cancellation happened last.
        endedPlan: sql<Plan | null>`(select e.plan from subscription_events e where e.user_id = "subscriptions"."user_id" and e.kind = 'canceled' order by e.at desc limit 1)`,
      })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.plan, 'free'),
          eq(subscriptions.status, 'expired'),
          isNotNull(subscriptions.currentPeriodEnd),
          lte(subscriptions.currentPeriodEnd, now),
          gte(subscriptions.currentPeriodEnd, since),
          or(
            sql`${subscriptions.expiryNotifiedFor} is null`,
            // Compared at the precision a JavaScript Date keeps, which is what the mark was written with.
            sql`${subscriptions.expiryNotifiedFor} < date_trunc('milliseconds', ${subscriptions.currentPeriodEnd})`,
          ),
        ),
      )
      .orderBy(desc(subscriptions.currentPeriodEnd))
      .limit(limit);
  }

  async markReminded(
    userId: string,
    field: 'remindedWeekFor' | 'remindedDayFor' | 'expiryNotifiedFor',
    periodEnd: Date,
  ): Promise<void> {
    await this.db
      .update(subscriptions)
      .set({ [field]: periodEnd })
      .where(eq(subscriptions.userId, userId));
  }
}

const unitAmountCentsOf = (plan: Plan, cycle: BillingCycle): number =>
  isPaidPlan(plan) ? unitAmountCents(plan, cycle) : 0;
