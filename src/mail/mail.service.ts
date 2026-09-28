import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Sends through any SMTP provider (Resend, Postmark, SES, … all offer SMTP). With no `SMTP_HOST`
 * configured it logs the message instead — so signup, verification and reset links are usable in
 * local development without an email account.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transport: Transporter | null;
  private readonly from: string;

  constructor(config: ConfigService) {
    this.from =
      config.get<string>('MAIL_FROM')?.trim() || 'IPScope <no-reply@localhost>';

    const host = config.get<string>('SMTP_HOST')?.trim();
    if (!host) {
      this.transport = null;
      this.logger.warn(
        'SMTP_HOST is not set — emails are printed to the log instead of being sent.',
      );
      return;
    }

    const user = config.get<string>('SMTP_USER')?.trim();
    this.transport = createTransport({
      host,
      port: Number(config.get<string>('SMTP_PORT') ?? 587),
      secure: config.get<string>('SMTP_SECURE') === 'true',
      auth: user
        ? { user, pass: config.get<string>('SMTP_PASSWORD') ?? '' }
        : undefined,
    });
  }

  /** False when no SMTP server is set and emails are only logged. */
  get configured(): boolean {
    return this.transport !== null;
  }

  async send(message: MailMessage): Promise<void> {
    if (!this.transport) {
      this.logger.log(
        `Email to ${message.to} — "${message.subject}"\n${message.text}`,
      );
      return;
    }

    await this.transport.sendMail({ from: this.from, ...message });
  }
}
