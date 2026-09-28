import { Logger } from '@nestjs/common';
import type { UsersService } from '../users/users.service';
import type { BillingMailService } from './billing-mail.service';
import { BillingJobs } from './billing-jobs.service';
import type { BillingService } from './billing.service';
import type {
  BillingRow,
  BillingStore,
  PaymentRow,
} from './billing-store.service';
import type { GatewayClient } from './gateway.client';
import { addDays } from './billing-rules';

beforeAll(() => Logger.overrideLogger(false));

const NOW = new Date('2026-09-26T12:00:00.000Z');
const HOUR = 3_600_000;

const row = (overrides: Partial<BillingRow> = {}): BillingRow => ({
  id: 'sub_1',
  userId: 'u_1',
  plan: 'pro',
  billingCycle: 'monthly',
  status: 'active',
  currentPeriodStart: addDays(NOW, -25),
  currentPeriodEnd: addDays(NOW, 5),
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

const pay = (id = 'pay_1', pollAttempts = 0): PaymentRow =>
  ({ id, pollAttempts }) as PaymentRow;

const setup = (
  options: {
    enabled?: boolean;
    due?: PaymentRow[];
    ending?: BillingRow[];
    lapsed?: { row: BillingRow; endedPlan: 'pro' | 'business' | null }[];
    verified?: boolean;
  } = {},
) => {
  const gateway = { enabled: options.enabled ?? true };
  const store = {
    claimDuePolls: jest.fn(() => Promise.resolve(options.due ?? [])),
    schedulePoll: jest.fn(() => Promise.resolve()),
    rollExpired: jest.fn(() =>
      Promise.resolve([] as { userId: string; from: string; to: string }[]),
    ),
    endingWithin: jest.fn(() => Promise.resolve(options.ending ?? [])),
    lapsedUnnotified: jest.fn(() => Promise.resolve(options.lapsed ?? [])),
    markReminded: jest.fn(() => Promise.resolve()),
  };
  const billing = {
    check: jest.fn(() => Promise.resolve({ outcome: 'still_pending' })),
  };
  const users = {
    findById: jest.fn(() =>
      Promise.resolve({
        id: 'u_1',
        name: 'Ada',
        email: 'a@example.com',
        emailVerified: options.verified ?? true,
      }),
    ),
  };
  const mail = {
    sendRenewalReminder: jest.fn(() => Promise.resolve(true)),
    sendExpired: jest.fn(() => Promise.resolve(true)),
  };
  const jobs = new BillingJobs(
    gateway as unknown as GatewayClient,
    store as unknown as BillingStore,
    billing as unknown as BillingService,
    users as unknown as UsersService,
    mail as unknown as BillingMailService,
  );
  return { jobs, store, billing, users, mail, gateway };
};

describe('BillingJobs.pollDue', () => {
  it('asks about every payment that is due', async () => {
    const { jobs, billing } = setup({ due: [pay('a'), pay('b')] });

    expect(await jobs.pollDue(NOW)).toBe(2);
    expect(billing.check).toHaveBeenCalledTimes(2);
  });

  it('does nothing when billing is off', async () => {
    const { jobs, store } = setup({ enabled: false });

    expect(await jobs.pollDue(NOW)).toBe(0);
    expect(store.claimDuePolls).not.toHaveBeenCalled();
  });

  it('only pushes that payment’s next try out when the gateway can not be asked, and carries on with the others', async () => {
    const { jobs, billing, store } = setup({ due: [pay('a', 1), pay('b')] });
    billing.check.mockRejectedValueOnce(new Error('gateway down'));

    await jobs.pollDue(NOW);

    expect(store.schedulePoll).toHaveBeenCalledWith('a', 2, NOW);
    expect(billing.check).toHaveBeenCalledTimes(2);
  });

  it('keeps to a small batch, because the gateway limits how often one address may ask', async () => {
    const { jobs, store } = setup();

    await jobs.pollDue(NOW);

    expect(store.claimDuePolls).toHaveBeenCalledWith(NOW, 5);
  });
});

describe('BillingJobs.rollExpired', () => {
  it('reports how many periods it ended', async () => {
    const { jobs, store } = setup();
    store.rollExpired.mockResolvedValueOnce([
      { userId: 'u_1', from: 'pro', to: 'free' },
      { userId: 'u_2', from: 'business', to: 'pro' },
    ]);

    expect(await jobs.rollExpired(NOW)).toBe(2);
  });
});

describe('BillingJobs.remind — before a period ends', () => {
  it('warns once, a week out', async () => {
    const { jobs, store, mail } = setup({
      ending: [row({ currentPeriodEnd: addDays(NOW, 5) })],
    });

    expect(await jobs.remind(NOW)).toBe(1);

    expect(mail.sendRenewalReminder).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'a@example.com' }),
      { planName: 'Pro', endsAt: addDays(NOW, 5) },
    );
    expect(store.markReminded).toHaveBeenCalledWith(
      'u_1',
      'remindedWeekFor',
      addDays(NOW, 5),
    );
  });

  it('warns again in the last day', async () => {
    const end = new Date(NOW.getTime() + 20 * HOUR);
    const { jobs, store } = setup({
      ending: [row({ currentPeriodEnd: end, remindedWeekFor: end })],
    });

    expect(await jobs.remind(NOW)).toBe(1);
    expect(store.markReminded).toHaveBeenCalledWith(
      'u_1',
      'remindedDayFor',
      end,
    );
  });

  it('never repeats a reminder it already sent for this period', async () => {
    const end = addDays(NOW, 5);
    const { jobs, mail } = setup({
      ending: [row({ currentPeriodEnd: end, remindedWeekFor: end })],
    });

    expect(await jobs.remind(NOW)).toBe(0);
    expect(mail.sendRenewalReminder).not.toHaveBeenCalled();
  });

  it('warns again after a renewal, because the period end moved', async () => {
    const { jobs, mail } = setup({
      ending: [
        row({
          currentPeriodEnd: addDays(NOW, 5),
          remindedWeekFor: addDays(NOW, -25),
        }),
      ],
    });

    expect(await jobs.remind(NOW)).toBe(1);
    expect(mail.sendRenewalReminder).toHaveBeenCalled();
  });

  it('has nothing to warn about when the next plan is already paid for', async () => {
    const { jobs, mail, store } = setup({
      ending: [row({ queuedPlan: 'pro', queuedCycle: 'monthly' })],
    });

    expect(await jobs.remind(NOW)).toBe(0);
    expect(mail.sendRenewalReminder).not.toHaveBeenCalled();
    expect(store.markReminded).not.toHaveBeenCalled();
  });

  it('marks an unverified address as reminded without emailing it, so it is not retried every pass', async () => {
    const { jobs, store, mail } = setup({ ending: [row()], verified: false });
    mail.sendRenewalReminder.mockResolvedValueOnce(false);

    expect(await jobs.remind(NOW)).toBe(0);
    expect(store.markReminded).toHaveBeenCalled();
  });
});

describe('BillingJobs.remind — after a period ended', () => {
  const lapsedRow = row({
    plan: 'free',
    status: 'expired',
    currentPeriodEnd: addDays(NOW, -1),
  });

  it('tells them once, naming the plan that ended', async () => {
    const { jobs, mail, store } = setup({
      lapsed: [{ row: lapsedRow, endedPlan: 'business' }],
    });

    expect(await jobs.remind(NOW)).toBe(1);

    expect(mail.sendExpired).toHaveBeenCalledWith(expect.anything(), {
      planName: 'Business',
    });
    expect(store.markReminded).toHaveBeenCalledWith(
      'u_1',
      'expiryNotifiedFor',
      addDays(NOW, -1),
    );
  });

  it('only looks at recent expiries — a plan that ended weeks ago is not news', async () => {
    const { jobs, store } = setup();

    await jobs.remind(NOW);

    const since = (
      store.lapsedUnnotified.mock.calls[0] as unknown as [Date, Date, number]
    )[1];
    expect(since.getTime()).toBe(NOW.getTime() - 3 * 24 * HOUR);
  });

  it('does not email when it does not know what plan ended', async () => {
    const { jobs, mail, store } = setup({
      lapsed: [{ row: lapsedRow, endedPlan: null }],
    });

    expect(await jobs.remind(NOW)).toBe(0);
    expect(mail.sendExpired).not.toHaveBeenCalled();
    expect(store.markReminded).toHaveBeenCalled();
  });
});
