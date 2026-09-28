import { Logger } from '@nestjs/common';
import { ApiException } from '../common/dto/api-exception';
import type { Plan, User } from '../contracts';
import type { UsersService } from '../users/users.service';
import type { BillingMailService } from './billing-mail.service';
import { addDays } from './billing-rules';
import type {
  BillingRow,
  BillingStore,
  PaymentRow,
} from './billing-store.service';
import {
  BillingService,
  toInvoiceView,
  toQuoteView,
  toSubscriptionView,
} from './billing.service';
import type { GatewayClient, GatewayInvoice } from './gateway.client';

beforeAll(() => Logger.overrideLogger(false));

const NOW = new Date('2026-09-26T12:00:00.000Z');

const user = (plan: Plan = 'free'): User =>
  ({ id: 'u_1', plan, email: 'a@example.com', name: 'Ada' }) as unknown as User;

const row = (overrides: Partial<BillingRow> = {}): BillingRow => ({
  id: 'sub_row_1',
  userId: 'u_1',
  plan: 'pro',
  billingCycle: 'monthly',
  status: 'active',
  currentPeriodStart: addDays(NOW, -10),
  currentPeriodEnd: addDays(NOW, 20),
  amountCents: 1900,
  syncedAt: null,
  queuedPlan: null,
  queuedCycle: null,
  remindedWeekFor: null,
  remindedDayFor: null,
  expiryNotifiedFor: null,
  createdAt: NOW,
  ...overrides,
});

const payment = (overrides: Partial<PaymentRow> = {}): PaymentRow => ({
  id: 'pay_1',
  seq: 42,
  userId: 'u_1',
  plan: 'pro',
  billingCycle: 'monthly',
  kind: 'purchase',
  amountCents: 1900,
  creditCents: 0,
  listPriceCents: 1900,
  status: 'pending',
  gatewayInvoiceNo: '1042',
  checkoutUrl: 'https://pay.example.com/i/1042',
  expiresAt: addDays(NOW, 1),
  createdAt: NOW,
  paidAt: null,
  appliedAt: null,
  nextPollAt: NOW,
  pollAttempts: 0,
  ...overrides,
});

const invoice = (overrides: Partial<GatewayInvoice> = {}): GatewayInvoice => ({
  invoiceNo: '2001',
  amountCents: 1900,
  status: 'pending',
  checkoutUrl: 'https://pay.example.com/i/2001',
  expiresAt: addDays(NOW, 1),
  ...overrides,
});

const setup = (
  options: {
    enabled?: boolean;
    webhookSecret?: string;
    row?: BillingRow;
    open?: PaymentRow[];
  } = {},
) => {
  const enabled = options.enabled ?? true;
  const gateway = {
    enabled,
    webhookSecret: options.webhookSecret ?? 'whsec',
    webUrl: 'https://app.example.com',
    require: jest.fn(() => {
      if (!enabled) {
        throw new ApiException(
          'PROVIDER_UNAVAILABLE',
          "Billing isn't available right now.",
        );
      }
    }),
    createInvoice: jest.fn(() => Promise.resolve(invoice())),
    getInvoice: jest.fn(() => Promise.resolve(invoice({ invoiceNo: '1042' }))),
    verifyWebhook: jest.fn((): string | null => '1042'),
  };
  const store = {
    getByUser: jest.fn(() => Promise.resolve(options.row)),
    pendingFor: jest.fn(() => Promise.resolve(options.open ?? [])),
    listPayments: jest.fn(() => Promise.resolve([] as PaymentRow[])),
    createPayment: jest.fn((input: { plan: Plan }) =>
      Promise.resolve(
        payment({
          id: 'pay_new',
          plan: input.plan,
          gatewayInvoiceNo: '2001',
          checkoutUrl: 'https://pay.example.com/i/2001',
        }),
      ),
    ),
    findByInvoiceNo: jest.fn(() =>
      Promise.resolve(payment() as PaymentRow | undefined),
    ),
    settle: jest.fn((): Promise<unknown> =>
      Promise.resolve({ outcome: 'still_pending' }),
    ),
    schedulePoll: jest.fn(() => Promise.resolve()),
    expire: jest.fn(() => Promise.resolve()),
  };
  const users = {
    findById: jest.fn(() =>
      Promise.resolve({
        id: 'u_1',
        name: 'Ada',
        email: 'a@example.com',
        emailVerified: true,
      }),
    ),
  };
  const mail = { sendReceipt: jest.fn(() => Promise.resolve(true)) };
  const service = new BillingService(
    gateway as unknown as GatewayClient,
    store as unknown as BillingStore,
    users as unknown as UsersService,
    mail as unknown as BillingMailService,
  );
  return { service, gateway, store, users, mail };
};

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as ApiException;
  }
  throw new Error('expected a rejection');
};

describe('toSubscriptionView', () => {
  it('shows a Free account on the calendar month, with nothing to pay', () => {
    expect(toSubscriptionView(user('free'), undefined, undefined, NOW)).toEqual(
      {
        id: 'plan_u_1',
        plan: 'free',
        status: 'active',
        billingCycle: 'monthly',
        currentPeriodStart: '2026-09-01T00:00:00.000Z',
        currentPeriodEnd: '2026-10-01T00:00:00.000Z',
        amount: 0,
        renewalDue: false,
        queued: null,
        pendingPayment: null,
      },
    );
  });

  it('shows a paid period with its end date and the price of one period', () => {
    const view = toSubscriptionView(user('pro'), row(), undefined, NOW);

    expect(view).toMatchObject({
      id: 'sub_row_1',
      plan: 'pro',
      billingCycle: 'monthly',
      currentPeriodStart: addDays(NOW, -10).toISOString(),
      currentPeriodEnd: addDays(NOW, 20).toISOString(),
      amount: 19,
      renewalDue: false,
    });
  });

  it('prices an annual period at the annual price', () => {
    const view = toSubscriptionView(
      user('business'),
      row({ plan: 'business', billingCycle: 'annual', amountCents: 75_600 }),
      undefined,
      NOW,
    );

    expect(view.amount).toBe(756);
  });

  it('says it is time to renew in the last week, and not before', () => {
    const soon = row({ currentPeriodEnd: addDays(NOW, 6) });
    const later = row({ currentPeriodEnd: addDays(NOW, 8) });

    expect(
      toSubscriptionView(user('pro'), soon, undefined, NOW).renewalDue,
    ).toBe(true);
    expect(
      toSubscriptionView(user('pro'), later, undefined, NOW).renewalDue,
    ).toBe(false);
  });

  it('shows a plan already paid for after this one', () => {
    const view = toSubscriptionView(
      user('business'),
      row({ plan: 'business', queuedPlan: 'pro', queuedCycle: 'monthly' }),
      undefined,
      NOW,
    );

    expect(view.queued).toEqual({ plan: 'pro', billingCycle: 'monthly' });
  });

  it('offers to resume an invoice that is waiting to be paid', () => {
    const view = toSubscriptionView(user('free'), undefined, payment(), NOW);

    expect(view.pendingPayment).toEqual({
      id: 'pay_1',
      plan: 'pro',
      billingCycle: 'monthly',
      amount: 19,
      checkoutUrl: 'https://pay.example.com/i/1042',
      expiresAt: addDays(NOW, 1).toISOString(),
    });
  });

  it('treats a period that has ended as Free', () => {
    const ended = row({ currentPeriodEnd: addDays(NOW, -1) });

    const view = toSubscriptionView(user('free'), ended, undefined, NOW);

    expect(view).toMatchObject({
      id: 'plan_u_1',
      plan: 'free',
      amount: 0,
      renewalDue: false,
    });
  });

  it('shows an Enterprise plan arranged by hand as it is, whatever a stray row says', () => {
    const view = toSubscriptionView(user('enterprise'), row(), undefined, NOW);

    expect(view).toMatchObject({ plan: 'enterprise', amount: 0 });
  });
});

describe('toInvoiceView', () => {
  it('numbers the invoice, converts to dollars and describes what it buys', () => {
    expect(toInvoiceView(payment({ status: 'paid' }), NOW)).toEqual({
      id: 'pay_1',
      number: 'IPS-00042',
      issuedAt: NOW.toISOString(),
      description: 'IPScope Pro, 30 days',
      amount: 19,
      status: 'paid',
      hostedUrl: null,
    });
  });

  it.each([
    ['pending', 'open'],
    ['paid', 'paid'],
    ['failed', 'failed'],
    ['expired', 'failed'],
    ['refunded', 'refunded'],
  ])('shows a %s payment as %s', (status, shown) => {
    expect(toInvoiceView(payment({ status }), NOW).status).toBe(shown);
  });

  it('links an open invoice to where it is paid, until it expires', () => {
    expect(toInvoiceView(payment(), NOW).hostedUrl).toBe(
      'https://pay.example.com/i/1042',
    );
    expect(
      toInvoiceView(payment({ expiresAt: addDays(NOW, -1) }), NOW).hostedUrl,
    ).toBeNull();
  });

  it('describes each kind of payment', () => {
    expect(
      toInvoiceView(payment({ billingCycle: 'annual' }), NOW).description,
    ).toBe('IPScope Pro, 1 year');
    expect(
      toInvoiceView(payment({ kind: 'renewal' }), NOW).description,
    ).toContain('(renewal)');
    expect(
      toInvoiceView(payment({ kind: 'queue' }), NOW).description,
    ).toContain('starts when your current plan ends');
    expect(
      toInvoiceView(
        payment({ kind: 'upgrade', plan: 'business', creditCents: 1266 }),
        NOW,
      ).description,
    ).toBe(
      'IPScope Business, 30 days (upgrade, $12.66 credit for unused days)',
    );
  });
});

describe('toQuoteView', () => {
  it('shows dollars and an ISO start', () => {
    expect(
      toQuoteView({
        kind: 'upgrade',
        amountCents: 6634,
        creditCents: 1266,
        listPriceCents: 7900,
        startsAt: NOW,
      }),
    ).toEqual({
      kind: 'upgrade',
      amount: 66.34,
      credit: 12.66,
      listPrice: 79,
      startsAt: NOW.toISOString(),
    });
  });

  it('shows nothing to pay as zeros', () => {
    expect(toQuoteView({ kind: 'none' })).toEqual({
      kind: 'none',
      amount: 0,
      credit: 0,
      listPrice: 0,
      startsAt: null,
    });
  });
});

describe('BillingService.changePlan — buying', () => {
  it('opens an invoice for the full price and sends the customer to pay it', async () => {
    const { service, gateway, store } = setup();

    const result = await service.changePlan(user('free'), {
      plan: 'pro',
      billingCycle: 'monthly',
    });

    expect(gateway.createInvoice).toHaveBeenCalledWith(
      1900,
      'https://app.example.com/billing?checkout=success',
    );
    expect(store.createPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u_1',
        plan: 'pro',
        billingCycle: 'monthly',
        kind: 'purchase',
        amountCents: 1900,
        creditCents: 0,
        listPriceCents: 1900,
      }),
    );
    expect(result.checkoutUrl).toBe('https://pay.example.com/i/2001');
    expect(result.subscription?.pendingPayment?.checkoutUrl).toBe(
      'https://pay.example.com/i/2001',
    );
  });

  it('charges the annual price for a year', async () => {
    const { service, gateway } = setup();

    await service.changePlan(user('free'), {
      plan: 'business',
      billingCycle: 'annual',
    });

    expect(gateway.createInvoice).toHaveBeenCalledWith(
      75_600,
      expect.any(String),
    );
  });

  it('charges an upgrade the new price less the unused days of the old plan', async () => {
    const { service, gateway, store } = setup({
      row: row({
        periodStart: undefined,
        currentPeriodStart: new Date(Date.now() - 10 * 86_400_000),
        currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
      } as Partial<BillingRow>),
    });

    await service.changePlan(user('pro'), {
      plan: 'business',
      billingCycle: 'monthly',
    });

    const [amount] = gateway.createInvoice.mock.calls[0] as unknown as [number];
    expect(amount).toBeLessThan(7900);
    expect(amount).toBeGreaterThan(7900 - 1900);
    expect(store.createPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'upgrade',
        listPriceCents: 7900,
        creditCents: 7900 - amount,
      }),
    );
  });

  it('asks for the full price to renew the same plan', async () => {
    const { service, gateway, store } = setup({
      row: row({
        currentPeriodStart: new Date(Date.now() - 10 * 86_400_000),
        currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
      }),
    });

    await service.changePlan(user('pro'), {
      plan: 'pro',
      billingCycle: 'monthly',
    });

    expect(gateway.createInvoice).toHaveBeenCalledWith(
      1900,
      expect.any(String),
    );
    expect(store.createPayment).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'renewal' }),
    );
  });

  it('buys a smaller plan now to start when the current one ends', async () => {
    const { service, store } = setup({
      row: row({
        plan: 'business',
        amountCents: 7900,
        currentPeriodStart: new Date(Date.now() - 10 * 86_400_000),
        currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
      }),
    });

    await service.changePlan(user('business'), {
      plan: 'pro',
      billingCycle: 'monthly',
    });

    expect(store.createPayment).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'queue', amountCents: 1900 }),
    );
  });

  it('will not buy a second plan in advance', async () => {
    const { service, gateway } = setup({
      row: row({
        plan: 'business',
        queuedPlan: 'pro',
        queuedCycle: 'monthly',
        currentPeriodStart: new Date(Date.now() - 10 * 86_400_000),
        currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
      }),
    });

    const error = await errorOf(
      service.changePlan(user('business'), {
        plan: 'pro',
        billingCycle: 'annual',
      }),
    );

    expect(error.code).toBe('CONFLICT');
    expect(error.message).toContain('Pro');
    expect(gateway.createInvoice).not.toHaveBeenCalled();
  });
});

describe('BillingService.changePlan — the rest', () => {
  it('opens nothing for Free: a paid period just runs out', async () => {
    const { service, gateway } = setup({ row: row() });

    const result = await service.changePlan(user('pro'), {
      plan: 'free',
      billingCycle: 'monthly',
    });

    expect(result.checkoutUrl).toBeNull();
    expect(result.subscription).not.toBeNull();
    expect(gateway.createInvoice).not.toHaveBeenCalled();
  });

  it('does not let an Enterprise customer self-serve', async () => {
    const { service, gateway } = setup();

    const error = await errorOf(
      service.changePlan(user('enterprise'), {
        plan: 'pro',
        billingCycle: 'monthly',
      }),
    );

    expect(error.code).toBe('CONFLICT');
    expect(gateway.createInvoice).not.toHaveBeenCalled();
  });

  it('answers 503 when billing is not configured', async () => {
    const { service } = setup({ enabled: false });

    expect(
      (
        await errorOf(
          service.changePlan(user('free'), {
            plan: 'pro',
            billingCycle: 'monthly',
          }),
        )
      ).code,
    ).toBe('PROVIDER_UNAVAILABLE');
  });

  it('sends them back to the same invoice instead of opening another', async () => {
    const { service, gateway, store } = setup({ open: [payment()] });

    const result = await service.changePlan(user('free'), {
      plan: 'pro',
      billingCycle: 'monthly',
    });

    expect(result.checkoutUrl).toBe('https://pay.example.com/i/1042');
    expect(gateway.createInvoice).not.toHaveBeenCalled();
    expect(store.createPayment).not.toHaveBeenCalled();
  });

  it('opens a new one when what is open is for something else', async () => {
    const { service, gateway } = setup({
      open: [payment({ plan: 'business', amountCents: 7900 })],
    });

    await service.changePlan(user('free'), {
      plan: 'pro',
      billingCycle: 'monthly',
    });

    expect(gateway.createInvoice).toHaveBeenCalledTimes(1);
  });

  it('caps how many unpaid invoices one customer can have open', async () => {
    const { service, gateway } = setup({
      open: [
        payment({ id: 'a', plan: 'business', amountCents: 7900 }),
        payment({ id: 'b', billingCycle: 'annual', amountCents: 18_000 }),
        payment({
          id: 'c',
          plan: 'business',
          billingCycle: 'annual',
          amountCents: 75_600,
        }),
      ],
    });

    const error = await errorOf(
      service.changePlan(user('free'), {
        plan: 'pro',
        billingCycle: 'monthly',
      }),
    );

    expect(error.code).toBe('CONFLICT');
    expect(gateway.createInvoice).not.toHaveBeenCalled();
  });

  it('answers a double click with one invoice', async () => {
    const { service, gateway } = setup();
    const target = { plan: 'pro', billingCycle: 'monthly' } as const;

    const [first, second] = await Promise.all([
      service.changePlan(user('free'), target),
      service.changePlan(user('free'), target),
    ]);

    expect(first).toEqual(second);
    expect(gateway.createInvoice).toHaveBeenCalledTimes(1);
  });

  it('refuses to send anyone to a checkout that has no address', async () => {
    const { service, store } = setup();

    (service as any).gateway.createInvoice.mockResolvedValueOnce(
      invoice({ checkoutUrl: null }),
    );

    const error = await errorOf(
      service.changePlan(user('free'), {
        plan: 'pro',
        billingCycle: 'monthly',
      }),
    );

    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(store.createPayment).not.toHaveBeenCalled();
  });

  it('lets a gateway failure through as a 503 and records nothing', async () => {
    const { service, gateway, store } = setup();
    gateway.createInvoice.mockRejectedValueOnce(
      new ApiException('PROVIDER_UNAVAILABLE', 'down'),
    );

    const error = await errorOf(
      service.changePlan(user('free'), {
        plan: 'pro',
        billingCycle: 'monthly',
      }),
    );

    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(store.createPayment).not.toHaveBeenCalled();
  });
});

describe('BillingService.quote', () => {
  it('works out the cost without touching the gateway — it works with billing off', async () => {
    const { service, gateway } = setup({ enabled: false });

    const quote = await service.quote(user('free'), {
      plan: 'pro',
      billingCycle: 'annual',
    });

    expect(quote).toMatchObject({
      kind: 'purchase',
      amount: 180,
      credit: 0,
      listPrice: 180,
    });
    expect(gateway.createInvoice).not.toHaveBeenCalled();
  });

  it('has nothing to charge for Free', async () => {
    const { service } = setup();

    expect(
      (
        await service.quote(user('pro'), {
          plan: 'free',
          billingCycle: 'monthly',
        })
      ).kind,
    ).toBe('none');
  });
});

describe('BillingService.check', () => {
  it('applies what the gateway says and thanks the customer when a plan was granted', async () => {
    const { service, store, mail } = setup({ row: row() });
    store.settle.mockResolvedValueOnce({
      outcome: 'granted',
      grant: 'started',
      userId: 'u_1',
    });

    const result = await service.check(payment(), NOW);
    await new Promise((resolve) => setImmediate(resolve));

    expect(store.settle).toHaveBeenCalledWith(
      'pay_1',
      expect.objectContaining({ invoiceNo: '1042' }),
      NOW,
    );
    expect(result).toMatchObject({ outcome: 'granted' });
    expect(mail.sendReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'a@example.com' }),
      expect.objectContaining({
        planName: 'Pro',
        amountCents: 1900,
        queued: false,
      }),
    );
  });

  it('says a plan bought in advance is queued in the receipt', async () => {
    const { service, store, mail } = setup({ row: row() });
    store.settle.mockResolvedValueOnce({
      outcome: 'granted',
      grant: 'queued',
      userId: 'u_1',
    });

    await service.check(payment({ kind: 'queue' }), NOW);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mail.sendReceipt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ queued: true }),
    );
  });

  it('asks again later while the invoice is still waiting, backing off', async () => {
    const { service, store } = setup();

    await service.check(payment({ pollAttempts: 2 }), NOW);

    expect(store.schedulePoll).toHaveBeenCalledWith('pay_1', 3, NOW);
    expect(store.expire).not.toHaveBeenCalled();
  });

  it('gives up on an invoice that expired well over ten minutes ago', async () => {
    const { service, store } = setup();

    await service.check(
      payment({ expiresAt: new Date(NOW.getTime() - 11 * 60_000) }),
      NOW,
    );

    expect(store.expire).toHaveBeenCalledWith('pay_1', NOW);
    expect(store.schedulePoll).not.toHaveBeenCalled();
  });

  it('keeps asking through the grace period after expiry, in case it was paid at the last minute', async () => {
    const { service, store } = setup();

    await service.check(
      payment({ expiresAt: new Date(NOW.getTime() - 5 * 60_000) }),
      NOW,
    );

    expect(store.schedulePoll).toHaveBeenCalled();
    expect(store.expire).not.toHaveBeenCalled();
  });

  it('does not schedule anything once the payment is settled one way or another', async () => {
    const { service, store } = setup();
    store.settle.mockResolvedValueOnce({ outcome: 'failed' });

    await service.check(payment(), NOW);

    expect(store.schedulePoll).not.toHaveBeenCalled();
    expect(store.expire).not.toHaveBeenCalled();
  });

  it('lets a gateway failure surface so the caller can retry later', async () => {
    const { service, gateway } = setup();
    gateway.getInvoice.mockRejectedValueOnce(
      new ApiException('PROVIDER_UNAVAILABLE', 'down'),
    );

    await expect(service.check(payment(), NOW)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('does not let a failed receipt email undo a granted plan', async () => {
    const { service, store, mail } = setup({ row: row() });
    store.settle.mockResolvedValueOnce({
      outcome: 'granted',
      grant: 'started',
      userId: 'u_1',
    });
    mail.sendReceipt.mockRejectedValueOnce(new Error('smtp down'));

    await expect(service.check(payment(), NOW)).resolves.toMatchObject({
      outcome: 'granted',
    });
    await new Promise((resolve) => setImmediate(resolve));
  });
});

describe('BillingService.refresh', () => {
  it('checks each open invoice and shows the result', async () => {
    const { service, gateway, store } = setup({
      open: [payment(), payment({ id: 'pay_2', gatewayInvoiceNo: '1043' })],
    });

    await service.refresh(user('free'), NOW);

    expect(gateway.getInvoice).toHaveBeenCalledTimes(2);
    expect(store.settle).toHaveBeenCalledTimes(2);
  });

  it('shows what it has when the gateway can not be asked', async () => {
    const { service, gateway } = setup({ open: [payment()] });
    gateway.getInvoice.mockRejectedValueOnce(
      new ApiException('PROVIDER_UNAVAILABLE', 'down'),
    );

    await expect(service.refresh(user('free'), NOW)).resolves.toMatchObject({
      plan: 'free',
    });
  });

  it('just shows the plan when billing is off', async () => {
    const { service, gateway } = setup({ enabled: false, open: [payment()] });

    await expect(service.refresh(user('free'), NOW)).resolves.toMatchObject({
      plan: 'free',
    });
    expect(gateway.getInvoice).not.toHaveBeenCalled();
  });
});

describe('BillingService.handleWebhook', () => {
  const body = Buffer.from('{}');

  it('is 503 when billing, or the webhook secret, is not set', async () => {
    expect(
      (
        await errorOf(
          setup({ enabled: false }).service.handleWebhook(body, 'sig'),
        )
      ).code,
    ).toBe('PROVIDER_UNAVAILABLE');
    expect(
      (
        await errorOf(
          setup({ webhookSecret: '' }).service.handleWebhook(body, 'sig'),
        )
      ).code,
    ).toBe('PROVIDER_UNAVAILABLE');
  });

  it('refuses a message that is not signed by the gateway', async () => {
    const { service, gateway, store } = setup();
    gateway.verifyWebhook.mockReturnValueOnce(null);

    const error = await errorOf(service.handleWebhook(body, 'forged'));

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe('Invalid webhook signature.');
    expect(store.findByInvoiceNo).not.toHaveBeenCalled();
  });

  it('acts on what the gateway says the invoice is now, not on the message', async () => {
    const { service, gateway, store } = setup();

    await service.handleWebhook(body, 'good', NOW);

    expect(store.findByInvoiceNo).toHaveBeenCalledWith('1042');
    expect(gateway.getInvoice).toHaveBeenCalledWith('1042');
    expect(store.settle).toHaveBeenCalled();
  });

  it('ignores an invoice on our payment link that is not ours', async () => {
    const { service, gateway, store } = setup();
    store.findByInvoiceNo.mockResolvedValueOnce(undefined);

    await expect(
      service.handleWebhook(body, 'good', NOW),
    ).resolves.toBeUndefined();
    expect(gateway.getInvoice).not.toHaveBeenCalled();
  });
});

describe('BillingService reads', () => {
  it('lists the catalogue', () => {
    expect(
      setup()
        .service.plans()
        .map((plan) => plan.id),
    ).toEqual(['free', 'pro', 'business', 'enterprise']);
  });

  it('lists a user’s invoices as the billing page shows them', async () => {
    const { service, store } = setup();
    store.listPayments.mockResolvedValueOnce([payment({ status: 'paid' })]);

    await expect(service.invoices(user('pro'), NOW)).resolves.toEqual([
      expect.objectContaining({
        number: 'IPS-00042',
        amount: 19,
        status: 'paid',
      }),
    ]);
  });
});
