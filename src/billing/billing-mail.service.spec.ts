import { Logger } from '@nestjs/common';
import type { MailService } from '../mail/mail.service';
import { BillingMailService } from './billing-mail.service';
import type { GatewayClient } from './gateway.client';

beforeAll(() => Logger.overrideLogger(false));

const ada = { name: 'Ada <b>', email: 'ada@example.com', emailVerified: true };

const setup = () => {
  const mail = { send: jest.fn(() => Promise.resolve()) };
  const service = new BillingMailService(
    mail as unknown as MailService,
    { webUrl: 'https://app.example.com' } as unknown as GatewayClient,
  );
  return { service, mail };
};

describe('BillingMailService', () => {
  it('sends a receipt naming the plan, the amount and how long it runs', async () => {
    const { service, mail } = setup();

    const sent = await service.sendReceipt(ada, {
      planName: 'Pro',
      amountCents: 1900,
      coveredUntil: new Date('2026-10-26T12:00:00.000Z'),
      queued: false,
    });

    expect(sent).toBe(true);
    const message = (
      mail.send.mock.calls[0] as unknown as [
        { to: string; subject: string; text: string },
      ]
    )[0];
    expect(message.to).toBe('ada@example.com');
    expect(message.subject).toBe('Payment received: IPScope Pro');
    expect(message.text).toContain('$19.00');
    expect(message.text).toContain('October 26, 2026');
    expect(message.text).toContain('https://app.example.com/billing');
  });

  it('says so when a plan is paid for but starts later', async () => {
    const { service, mail } = setup();

    await service.sendReceipt(ada, {
      planName: 'Pro',
      amountCents: 1900,
      coveredUntil: new Date('2026-10-26T12:00:00.000Z'),
      queued: true,
    });

    expect(
      (mail.send.mock.calls[0] as unknown as [{ text: string }])[0].text,
    ).toContain('starts when your current plan ends');
  });

  it('warns that nothing renews by itself, and says what is lost', async () => {
    const { service, mail } = setup();

    await service.sendRenewalReminder(ada, {
      planName: 'Business',
      endsAt: new Date('2026-10-01T00:00:00.000Z'),
    });

    const message = (
      mail.send.mock.calls[0] as unknown as [{ subject: string; text: string }]
    )[0];
    expect(message.subject).toContain('ends on October 1, 2026');
    expect(message.text).toContain("don't renew by themselves");
    expect(message.text).toContain('renew any time');
  });

  it('tells them when the plan has ended, and that their data is safe', async () => {
    const { service, mail } = setup();

    await service.sendExpired(ada, { planName: 'Pro' });

    const message = (
      mail.send.mock.calls[0] as unknown as [{ subject: string; text: string }]
    )[0];
    expect(message.subject).toContain('has ended');
    expect(message.text).toContain('Free plan');
    expect(message.text).toContain('history and settings');
  });

  it('never emails an address the user has not verified', async () => {
    const { service, mail } = setup();

    expect(
      await service.sendExpired(
        { ...ada, emailVerified: false },
        { planName: 'Pro' },
      ),
    ).toBe(false);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('escapes what it puts in the HTML body', async () => {
    const { service, mail } = setup();

    await service.sendExpired(ada, { planName: 'Pro' });

    const message = (
      mail.send.mock.calls[0] as unknown as [{ html: string }]
    )[0];
    expect(message.html).toContain('Ada &lt;b&gt;');
    expect(message.html).not.toContain('Ada <b>');
  });

  it('logs a mail outage and reports it, instead of throwing into a job', async () => {
    const { service, mail } = setup();
    mail.send.mockRejectedValueOnce(new Error('smtp down'));

    await expect(service.sendExpired(ada, { planName: 'Pro' })).resolves.toBe(
      false,
    );
  });
});
