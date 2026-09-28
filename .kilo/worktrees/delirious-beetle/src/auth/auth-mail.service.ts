import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { escapeHtml } from '../mail/escape-html';
import { MailService } from '../mail/mail.service';

/**
 * Both emails are best-effort: a failure is logged, never thrown, so a mail outage can't make
 * signup fail or reveal (through timing or errors) whether an address is registered.
 * The links point at ipscope-web pages (`/verify-email`, `/reset-password`).
 */
@Injectable()
export class AuthMailService {
  private readonly logger = new Logger(AuthMailService.name);
  private readonly webUrl: string;

  constructor(
    private readonly mail: MailService,
    config: ConfigService,
  ) {
    this.webUrl = (
      config.get<string>('APP_WEB_URL')?.trim() || 'http://localhost:3000'
    ).replace(/\/+$/, '');
  }

  async sendVerification(
    to: string,
    name: string,
    token: string,
  ): Promise<void> {
    const link = `${this.webUrl}/verify-email?token=${encodeURIComponent(token)}`;
    await this.deliver({
      to,
      subject: 'Verify your IPScope email',
      text: `Hi ${name},\n\nConfirm your email address to finish setting up IPScope:\n${link}\n\nThe link works for 24 hours. If you didn't create an account, ignore this email.`,
      html: `<p>Hi ${escapeHtml(name)},</p><p>Confirm your email address to finish setting up IPScope:</p><p><a href="${link}">Verify my email</a></p><p>The link works for 24 hours. If you didn't create an account, ignore this email.</p>`,
    });
  }

  async sendPasswordReset(
    to: string,
    name: string,
    token: string,
  ): Promise<void> {
    const link = `${this.webUrl}/reset-password?token=${encodeURIComponent(token)}`;
    await this.deliver({
      to,
      subject: 'Reset your IPScope password',
      text: `Hi ${name},\n\nSomeone asked to reset the password for this account. Choose a new one here:\n${link}\n\nThe link works for 1 hour. If this wasn't you, ignore this email — your password stays the same.`,
      html: `<p>Hi ${escapeHtml(name)},</p><p>Someone asked to reset the password for this account. Choose a new one here:</p><p><a href="${link}">Reset my password</a></p><p>The link works for 1 hour. If this wasn't you, ignore this email — your password stays the same.</p>`,
    });
  }

  private async deliver(message: Parameters<MailService['send']>[0]) {
    try {
      await this.mail.send(message);
    } catch (error) {
      this.logger.error(
        `Could not send "${message.subject}" to ${message.to}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
