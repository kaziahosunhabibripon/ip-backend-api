import { Injectable, Logger } from '@nestjs/common';
import { escapeHtml } from '../mail/escape-html';
import { MailService } from '../mail/mail.service';
import { GatewayClient } from './gateway.client';

export interface BillingRecipient {
  name: string;
  email: string;
  emailVerified: boolean;
}

const dateOf = (date: Date) =>
  date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * The emails a prepaid plan needs: a receipt, a heads-up before the paid period ends, and a note when it has.
 * Nothing renews by itself, so the reminder is what stands between a customer and a surprise downgrade.
 * Like every email here it is best-effort and goes only to an address the user has verified.
 */
@Injectable()
export class BillingMailService {
  private readonly logger = new Logger(BillingMailService.name);

  constructor(
    private readonly mail: MailService,
    private readonly gateway: GatewayClient,
  ) {}

  private get link() {
    return `${this.gateway.webUrl}/billing`;
  }

  sendReceipt(
    to: BillingRecipient,
    details: {
      planName: string;
      amountCents: number;
      coveredUntil: Date;
      queued: boolean;
    },
  ): Promise<boolean> {
    const line = details.queued
      ? `Your ${details.planName} plan is paid for and starts when your current plan ends. It then runs for its full period.`
      : `Your IPScope ${details.planName} plan is active until ${dateOf(details.coveredUntil)}.`;
    return this.send(to, `Payment received: IPScope ${details.planName}`, [
      `Thank you, ${to.name}. We received your payment of ${dollars(details.amountCents)}.`,
      line,
      `Your invoices are on your billing page: ${this.link}`,
    ]);
  }

  sendRenewalReminder(
    to: BillingRecipient,
    details: { planName: string; endsAt: Date },
  ): Promise<boolean> {
    return this.send(
      to,
      `Your IPScope ${details.planName} plan ends on ${dateOf(details.endsAt)}`,
      [
        `Hi ${to.name},`,
        `Your IPScope ${details.planName} plan is paid until ${dateOf(details.endsAt)}. Plans don't renew by themselves: after that date your account moves to the Free plan, and advanced intelligence, API access and monitoring are turned off. Your history stays.`,
        `To keep ${details.planName}, renew any time before then — the new period is added after the current one, so nothing is lost by paying early: ${this.link}`,
      ],
    );
  }

  sendExpired(
    to: BillingRecipient,
    details: { planName: string },
  ): Promise<boolean> {
    return this.send(to, `Your IPScope ${details.planName} plan has ended`, [
      `Hi ${to.name},`,
      `Your IPScope ${details.planName} plan has ended, so your account is now on the Free plan. Your history and settings are all still there.`,
      `You can pick the plan back up whenever you like: ${this.link}`,
    ]);
  }

  private async send(
    to: BillingRecipient,
    subject: string,
    paragraphs: string[],
  ): Promise<boolean> {
    if (!to.emailVerified) {
      return false;
    }
    try {
      await this.mail.send({
        to: to.email,
        subject,
        text: paragraphs.join('\n\n'),
        html: paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`).join(''),
      });
      return true;
    } catch (error) {
      this.logger.error(
        `Could not send "${subject}" to ${to.email}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}
