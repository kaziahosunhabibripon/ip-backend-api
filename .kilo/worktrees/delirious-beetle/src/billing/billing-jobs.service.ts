import { Injectable, Logger } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { BillingMailService } from './billing-mail.service';
import { BillingService, planName } from './billing.service';
import { BillingStore } from './billing-store.service';
import { GatewayClient } from './gateway.client';

const DAY_MS = 24 * 60 * 60_000;
const WEEK_MS = 7 * DAY_MS;
/** Payments asked about per pass. The gateway allows about twenty requests a minute from one address. */
const POLL_BATCH = 5;
const ROLL_BATCH = 100;
const REMINDER_BATCH = 200;
/** An expiry older than this is history, not news: nobody wants "your plan ended" three weeks late. */
const EXPIRY_NEWS_MS = 3 * DAY_MS;

/**
 * The three things a prepaid plan needs done in the background, each safe to run on several instances at once:
 * find out about payments that were made, end paid periods that ran out, and warn people before that happens.
 * `BillingScheduler` calls them on a timer; they take `now` so they can be tested without waiting.
 */
@Injectable()
export class BillingJobs {
  private readonly logger = new Logger(BillingJobs.name);

  constructor(
    private readonly gateway: GatewayClient,
    private readonly store: BillingStore,
    private readonly billing: BillingService,
    private readonly users: UsersService,
    private readonly mail: BillingMailService,
  ) {}

  /** Asks the gateway about payments that are due for it. A failed ask only pushes that payment's next try out. */
  async pollDue(now = new Date()): Promise<number> {
    if (!this.gateway.enabled) {
      return 0;
    }
    const due = await this.store.claimDuePolls(now, POLL_BATCH);
    for (const payment of due) {
      try {
        await this.billing.check(payment, now);
      } catch (error) {
        this.logger.warn(
          `Could not check payment ${payment.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        await this.store.schedulePoll(
          payment.id,
          payment.pollAttempts + 1,
          now,
        );
      }
    }
    return due.length;
  }

  /** Ends periods that ran out: the plan bought in advance starts, or the account goes back to Free. */
  async rollExpired(now = new Date()): Promise<number> {
    const moves = await this.store.rollExpired(now, ROLL_BATCH);
    for (const move of moves) {
      this.logger.log(
        `User ${move.userId}: ${move.from} → ${move.to} (period ended).`,
      );
    }
    return moves.length;
  }

  /** One reminder a week out and one a day out per period, and one note after a plan has ended. */
  async remind(now = new Date()): Promise<number> {
    let sent = 0;

    const ending = await this.store.endingWithin(now, WEEK_MS, REMINDER_BATCH);
    for (const row of ending) {
      const end = row.currentPeriodEnd;
      // Nothing to warn about when the next plan is already paid for.
      if (!end || row.queuedPlan) {
        continue;
      }
      const lastDay = end.getTime() - now.getTime() <= DAY_MS;
      const field = lastDay ? 'remindedDayFor' : 'remindedWeekFor';
      if (row[field]?.getTime() === end.getTime()) {
        continue;
      }
      // Still marked when the address isn't verified, so the same person isn't retried every pass.
      const user = await this.users.findById(row.userId);
      await this.store.markReminded(row.userId, field, end);
      if (
        user &&
        (await this.mail.sendRenewalReminder(user, {
          planName: planName(row.plan),
          endsAt: end,
        }))
      ) {
        sent += 1;
      }
    }

    const lapsed = await this.store.lapsedUnnotified(
      now,
      new Date(now.getTime() - EXPIRY_NEWS_MS),
      REMINDER_BATCH,
    );
    for (const { row, endedPlan } of lapsed) {
      const end = row.currentPeriodEnd;
      if (!end) {
        continue;
      }
      const user = await this.users.findById(row.userId);
      await this.store.markReminded(row.userId, 'expiryNotifiedFor', end);
      if (
        user &&
        endedPlan &&
        (await this.mail.sendExpired(user, { planName: planName(endedPlan) }))
      ) {
        sent += 1;
      }
    }
    return sent;
  }
}
