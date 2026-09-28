import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { escapeHtml } from '../mail/escape-html';
import { MailService } from '../mail/mail.service';

/** Best-effort, same as every other mail service here: a failure is logged, never thrown. */
@Injectable()
export class TeamMailService {
  private readonly logger = new Logger(TeamMailService.name);
  private readonly webUrl: string;

  constructor(
    private readonly mail: MailService,
    config: ConfigService,
  ) {
    this.webUrl = (
      config.get<string>('APP_WEB_URL')?.trim() || 'http://localhost:3000'
    ).replace(/\/+$/, '');
  }

  async sendInvite(input: {
    to: string;
    inviteeName: string;
    ownerName: string;
    teamName: string;
    token: string;
  }): Promise<void> {
    const link = `${this.webUrl}/team/accept?token=${encodeURIComponent(input.token)}`;
    await this.deliver({
      to: input.to,
      subject: `${input.ownerName} invited you to ${input.teamName} on IPScope`,
      text: `Hi ${input.inviteeName},\n\n${input.ownerName} invited you to join "${input.teamName}" on IPScope. Accepting gives you their plan's features and limits for as long as you're a member.\n\n${link}\n\nThe link works for 7 days. If you weren't expecting this, ignore this email.`,
      html: `<p>Hi ${escapeHtml(input.inviteeName)},</p><p>${escapeHtml(input.ownerName)} invited you to join "${escapeHtml(input.teamName)}" on IPScope. Accepting gives you their plan's features and limits for as long as you're a member.</p><p><a href="${link}">Join ${escapeHtml(input.teamName)}</a></p><p>The link works for 7 days. If you weren't expecting this, ignore this email.</p>`,
    });
  }

  async notifyRemoved(input: {
    to: string;
    name: string;
    teamName: string;
  }): Promise<void> {
    await this.deliver({
      to: input.to,
      subject: `You've left ${input.teamName} on IPScope`,
      text: `Hi ${input.name},\n\nYou're no longer a member of "${input.teamName}". Your account is back on your own plan.`,
      html: `<p>Hi ${escapeHtml(input.name)},</p><p>You're no longer a member of "${escapeHtml(input.teamName)}". Your account is back on your own plan.</p>`,
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
