import type { ConfigService } from '@nestjs/config';
import type { Alert, NotificationPreferences } from '../contracts';
import type { MailService } from '../mail/mail.service';
import {
  AlertMailService,
  EMAIL_COOLDOWN_MS,
  selectForEmail,
  type AlertRecipient,
} from './alert-mail.service';

const NOW = new Date('2026-09-24T12:00:00.000Z');

const prefs = (
  overrides: Partial<NotificationPreferences> = {},
): NotificationPreferences => ({
  monitorAlerts: true,
  securityAlerts: true,
  weeklyDigest: false,
  usageWarnings: true,
  productUpdates: false,
  ...overrides,
});

const alert = (overrides: Partial<Alert> = {}): Alert => ({
  id: 'alt_1',
  type: 'ip_changed',
  severity: 'medium',
  category: 'network',
  target: 'example.com',
  message: 'New address: 1.1.1.1.',
  createdAt: NOW.toISOString(),
  read: false,
  monitorId: 'mon_1',
  ...overrides,
});

describe('selectForEmail', () => {
  it('emails medium and above, and keeps low and info in the app', () => {
    const chosen = selectForEmail(
      (['critical', 'high', 'medium', 'low', 'info'] as const).map(
        (severity, index) => alert({ id: `alt_${index}`, severity }),
      ),
      prefs(),
      null,
      NOW,
    );

    expect(chosen.map((a) => a.severity)).toEqual([
      'critical',
      'high',
      'medium',
    ]);
  });

  it('follows the two notification switches separately', () => {
    const alerts = [
      alert({ id: 'net', type: 'ip_changed' }),
      alert({ id: 'dns', type: 'dns_changed', category: 'dns' }),
      alert({ id: 'sec', type: 'security_changed', category: 'security' }),
      alert({ id: 'fail', type: 'monitor_failed', severity: 'high' }),
    ];

    expect(
      selectForEmail(alerts, prefs({ securityAlerts: false }), null, NOW).map(
        (a) => a.id,
      ),
    ).toEqual(['net', 'dns', 'fail']);
    expect(
      selectForEmail(alerts, prefs({ monitorAlerts: false }), null, NOW).map(
        (a) => a.id,
      ),
    ).toEqual(['sec']);
    expect(
      selectForEmail(
        alerts,
        prefs({ monitorAlerts: false, securityAlerts: false }),
        null,
        NOW,
      ),
    ).toEqual([]);
  });

  it('holds everything but critical back inside the cooldown', () => {
    const recently = new Date(NOW.getTime() - EMAIL_COOLDOWN_MS + 1000);
    const chosen = selectForEmail(
      [
        alert({ id: 'high', severity: 'high' }),
        alert({ id: 'critical', severity: 'critical' }),
      ],
      prefs(),
      recently,
      NOW,
    );

    expect(chosen.map((a) => a.id)).toEqual(['critical']);
  });

  it('emails again once the cooldown is over', () => {
    const long = new Date(NOW.getTime() - EMAIL_COOLDOWN_MS - 1000);
    expect(selectForEmail([alert()], prefs(), long, NOW)).toHaveLength(1);
  });
});

describe('AlertMailService', () => {
  const recipient = (
    overrides: Partial<AlertRecipient> = {},
  ): AlertRecipient => ({
    name: 'Alex <b>',
    email: 'alex@example.com',
    emailVerified: true,
    notificationPreferences: prefs(),
    ...overrides,
  });

  const setup = () => {
    const send = jest.fn((): Promise<void> => Promise.resolve());
    const service = new AlertMailService(
      { send } as unknown as MailService,
      {
        get: (key: string) =>
          key === 'APP_WEB_URL' ? 'https://app.example.com/' : undefined,
      } as unknown as ConfigService,
    );
    return { service, send };
  };

  it('never mails an address that has not been verified', async () => {
    const { service, send } = setup();

    const sent = await service.notify(
      recipient({ emailVerified: false }),
      [alert({ severity: 'critical' })],
      null,
      NOW,
    );

    expect(sent).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends one email for a run, listing every alert, with links into the site', async () => {
    const { service, send } = setup();

    const sent = await service.notify(
      recipient(),
      [
        alert({ id: 'a', message: 'New address: 1.1.1.1.' }),
        alert({
          id: 'b',
          type: 'dns_changed',
          severity: 'high',
          message: 'Nameservers changed.',
        }),
      ],
      null,
      NOW,
    );

    expect(sent).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const [message] = send.mock.calls[0] as unknown as [
      { to: string; subject: string; text: string; html: string },
    ];
    expect(message.to).toBe('alex@example.com');
    expect(message.subject).toBe(
      'IPScope alert: 2 things changed for example.com',
    );
    expect(message.text).toContain('[MEDIUM] IP addresses or hosting changed');
    expect(message.text).toContain('[HIGH] DNS records changed');
    expect(message.text).toContain('Nameservers changed.');
    expect(message.text).toContain('https://app.example.com/alerts');
    expect(message.text).toContain('https://app.example.com/settings');
  });

  it('names the alert in the subject when there is only one', async () => {
    const { service, send } = setup();

    await service.notify(
      recipient(),
      [alert({ type: 'monitor_failed', severity: 'high' })],
      null,
      NOW,
    );

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'IPScope alert: Monitoring is failing for example.com',
      }),
    );
  });

  it('escapes what it puts in the HTML', async () => {
    const { service, send } = setup();

    await service.notify(
      recipient(),
      [alert({ message: '<script>alert(1)</script>', target: 'a&b.example' })],
      null,
      NOW,
    );

    const [message] = send.mock.calls[0] as unknown as [{ html: string }];
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
    expect(message.html).toContain('Alex &lt;b&gt;');
    expect(message.html).toContain('a&amp;b.example');
  });

  it('sends nothing when no alert passes the filters', async () => {
    const { service, send } = setup();

    const sent = await service.notify(
      recipient(),
      [alert({ severity: 'low' })],
      null,
      NOW,
    );

    expect(sent).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('reports false, instead of throwing, when the mail server refuses', async () => {
    const { service, send } = setup();
    send.mockRejectedValueOnce(new Error('550 mailbox unavailable'));

    await expect(
      service.notify(recipient(), [alert()], null, NOW),
    ).resolves.toBe(false);
  });
});
