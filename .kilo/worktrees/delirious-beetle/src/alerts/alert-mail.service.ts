import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Alert, NotificationPreferences } from '../contracts';
import { escapeHtml } from '../mail/escape-html';
import { MailService } from '../mail/mail.service';
import { isAtLeast } from './severity';

/** Quieter than the inbox: low and info alerts stay in the app. */
const EMAIL_FLOOR = 'medium' as const;
/** After one alert email for a monitor, hold the next one back this long — a flapping target must not flood an inbox. */
export const EMAIL_COOLDOWN_MS = 30 * 60 * 1000;

export interface AlertRecipient {
  name: string;
  email: string;
  emailVerified: boolean;
  notificationPreferences: NotificationPreferences;
}

/**
 * Which of a run's alerts deserve an email: the ones the user has switched on (security alerts and monitor
 * alerts are separate settings), at medium severity or above, and — unless critical — not while the monitor
 * is still inside its cooldown from the previous email.
 */
export const selectForEmail = (
  alerts: Alert[],
  preferences: NotificationPreferences,
  lastEmailedAt: Date | null,
  now: Date,
): Alert[] => {
  const cooling =
    lastEmailedAt !== null &&
    now.getTime() - lastEmailedAt.getTime() < EMAIL_COOLDOWN_MS;

  return alerts.filter((alert) => {
    const wanted =
      alert.type === 'security_changed'
        ? preferences.securityAlerts
        : preferences.monitorAlerts;
    return (
      wanted &&
      isAtLeast(alert.severity, EMAIL_FLOOR) &&
      (!cooling || alert.severity === 'critical')
    );
  });
};

const HEADLINE: Record<Alert['type'], string> = {
  dns_changed: 'DNS records changed',
  ip_changed: 'IP addresses or hosting changed',
  security_changed: 'Security signals changed',
  monitor_failed: 'Monitoring is failing',
};

/**
 * Emails the owner when a monitor finds something. Best-effort like the account emails: a mail outage is
 * logged, never thrown, so it can't break a monitoring run — the alert is already in the inbox.
 */
@Injectable()
export class AlertMailService {
  private readonly logger = new Logger(AlertMailService.name);
  private readonly webUrl: string;

  constructor(
    private readonly mail: MailService,
    config: ConfigService,
  ) {
    this.webUrl = (
      config.get<string>('APP_WEB_URL')?.trim() || 'http://localhost:3000'
    ).replace(/\/+$/, '');
  }

  /** Returns whether an email actually went out, so the monitor can start its cooldown. */
  async notify(
    recipient: AlertRecipient,
    alerts: Alert[],
    lastEmailedAt: Date | null,
    now: Date,
  ): Promise<boolean> {
    // An unverified address could be anyone's: never send monitoring mail to it.
    if (!recipient.emailVerified) {
      return false;
    }

    const chosen = selectForEmail(
      alerts,
      recipient.notificationPreferences,
      lastEmailedAt,
      now,
    );
    if (chosen.length === 0) {
      return false;
    }

    const { subject, text, html } = this.compose(recipient.name, chosen);
    try {
      await this.mail.send({ to: recipient.email, subject, text, html });
      return true;
    } catch (error) {
      this.logger.error(
        `Could not send an alert email to ${recipient.email}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private compose(name: string, alerts: Alert[]) {
    const target = alerts[0].target;
    const subject =
      alerts.length === 1
        ? `IPScope alert: ${HEADLINE[alerts[0].type]} for ${target}`
        : `IPScope alert: ${alerts.length} things changed for ${target}`;
    const link = `${this.webUrl}/alerts`;
    const settings = `${this.webUrl}/settings`;

    const lines = alerts.map(
      (alert) =>
        `[${alert.severity.toUpperCase()}] ${HEADLINE[alert.type]}\n${alert.message}`,
    );
    const text = `Hi ${name},\n\nYour monitor for ${target} found something:\n\n${lines.join('\n\n')}\n\nSee everything in your alert inbox: ${link}\n\nYou get these emails because a monitor on your account watches ${target}. You can change which ones you receive in ${settings}.`;

    const items = alerts
      .map(
        (alert) =>
          `<li><strong>${escapeHtml(alert.severity.toUpperCase())} — ${escapeHtml(HEADLINE[alert.type])}</strong><br>${escapeHtml(alert.message)}</li>`,
      )
      .join('');
    const html = `<p>Hi ${escapeHtml(name)},</p><p>Your monitor for <strong>${escapeHtml(target)}</strong> found something:</p><ul>${items}</ul><p><a href="${link}">Open your alert inbox</a></p><p>You get these emails because a monitor on your account watches ${escapeHtml(target)}. You can change which ones you receive in <a href="${settings}">Settings</a>.</p>`;

    return { subject, text, html };
  }
}
