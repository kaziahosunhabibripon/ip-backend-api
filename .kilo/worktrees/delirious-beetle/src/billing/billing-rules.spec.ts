import type { BillingCycle, Plan } from '../contracts';
import {
  MIN_CHARGE_CENTS,
  PERIOD_DAYS,
  addDays,
  applyPayment,
  creditCents,
  isActive,
  planEventKind,
  quoteChange,
  roll,
  type Entitlement,
} from './billing-rules';

const NOW = new Date('2026-09-26T12:00:00.000Z');

const entitlement = (overrides: Partial<Entitlement> = {}): Entitlement => ({
  plan: 'pro',
  cycle: 'monthly',
  periodStart: addDays(NOW, -10),
  periodEnd: addDays(NOW, 20),
  paidCents: 1900,
  queued: null,
  ...overrides,
});

const target = (plan: Plan, cycle: BillingCycle = 'monthly') => ({
  plan,
  cycle,
});

describe('periods', () => {
  it('is 30 days for the monthly price and 365 for the annual one', () => {
    expect(PERIOD_DAYS).toEqual({ monthly: 30, annual: 365 });
  });
});

describe('isActive', () => {
  it('is true only for a paid plan whose period has not ended', () => {
    expect(isActive(entitlement(), NOW)).toBe(true);
    expect(isActive(entitlement({ periodEnd: addDays(NOW, -1) }), NOW)).toBe(
      false,
    );
    expect(isActive(entitlement({ periodEnd: NOW }), NOW)).toBe(false);
    expect(isActive(entitlement({ plan: 'free' }), NOW)).toBe(false);
    expect(isActive(null, NOW)).toBe(false);
    expect(isActive(undefined, NOW)).toBe(false);
  });
});

describe('creditCents', () => {
  it('is the unused share of what was paid', () => {
    // 20 of 30 days left on $19.00
    expect(creditCents(entitlement(), NOW)).toBe(1266);
  });

  it('is everything at the start of a period and nothing at the end', () => {
    const fresh = entitlement({
      periodStart: NOW,
      periodEnd: addDays(NOW, 30),
    });
    expect(creditCents(fresh, NOW)).toBe(1900);
    expect(creditCents(entitlement({ periodEnd: NOW }), NOW)).toBe(0);
    expect(creditCents(entitlement({ periodEnd: addDays(NOW, -3) }), NOW)).toBe(
      0,
    );
  });

  it('never exceeds what was paid, and counts a renewal that stacked two periods as paid twice', () => {
    const stacked = entitlement({
      periodStart: addDays(NOW, -10),
      periodEnd: addDays(NOW, 50),
      paidCents: 3800,
    });
    expect(creditCents(stacked, NOW)).toBe(3166);
    expect(creditCents(stacked, addDays(NOW, -1000))).toBeLessThanOrEqual(3800);
  });
});

describe('quoteChange', () => {
  it('has nothing to charge for Free or an unsold plan', () => {
    expect(quoteChange(entitlement(), target('free'), NOW)).toEqual({
      kind: 'none',
    });
    expect(quoteChange(null, target('enterprise'), NOW)).toEqual({
      kind: 'none',
    });
  });

  it('charges the full price of a first purchase, starting now', () => {
    expect(quoteChange(null, target('pro'), NOW)).toEqual({
      kind: 'purchase',
      amountCents: 1900,
      creditCents: 0,
      listPriceCents: 1900,
      startsAt: NOW,
    });
    expect(quoteChange(null, target('business', 'annual'), NOW)).toMatchObject({
      kind: 'purchase',
      amountCents: 75_600,
    });
  });

  it('treats a lapsed plan like no plan', () => {
    const lapsed = entitlement({ periodEnd: addDays(NOW, -2) });

    expect(quoteChange(lapsed, target('pro'), NOW)).toMatchObject({
      kind: 'purchase',
      amountCents: 1900,
      startsAt: NOW,
    });
  });

  it('charges the full price to renew, and adds the new period after the current one', () => {
    const current = entitlement();

    expect(quoteChange(current, target('pro'), NOW)).toEqual({
      kind: 'renewal',
      amountCents: 1900,
      creditCents: 0,
      listPriceCents: 1900,
      startsAt: current.periodEnd,
    });
  });

  it('charges an upgrade the price of the new plan less the unused days of the old one', () => {
    const quote = quoteChange(entitlement(), target('business'), NOW);

    expect(quote).toEqual({
      kind: 'upgrade',
      amountCents: 7900 - 1266,
      creditCents: 1266,
      listPriceCents: 7900,
      startsAt: NOW,
    });
  });

  it('treats monthly → annual on the same plan as an upgrade too', () => {
    const quote = quoteChange(entitlement(), target('pro', 'annual'), NOW);

    expect(quote).toMatchObject({
      kind: 'upgrade',
      amountCents: 18_000 - 1266,
      creditCents: 1266,
    });
  });

  it('never asks for less than the minimum, even when the credit covers the price', () => {
    const almostNew = entitlement({
      plan: 'business',
      cycle: 'annual',
      periodStart: NOW,
      periodEnd: addDays(NOW, 365),
      paidCents: 75_600,
    });
    const quote = quoteChange(almostNew, target('business', 'annual'), NOW);
    expect(quote.kind).toBe('renewal');

    const big = entitlement({
      plan: 'pro',
      cycle: 'monthly',
      periodStart: NOW,
      periodEnd: addDays(NOW, 30),
      paidCents: 100_000, // paid far more than the price, e.g. stacked renewals
    });
    const upgrade = quoteChange(big, target('business'), NOW);
    expect(upgrade).toMatchObject({
      kind: 'upgrade',
      amountCents: MIN_CHARGE_CENTS,
    });
    if (upgrade.kind !== 'none') {
      // what is shown as credit plus what is charged still adds up to the price
      expect(upgrade.creditCents + upgrade.amountCents).toBe(
        upgrade.listPriceCents,
      );
    }
  });

  it('buys a smaller plan now and starts it when the current one ends, with nothing refunded', () => {
    const current = entitlement({ plan: 'business', paidCents: 7900 });

    expect(quoteChange(current, target('pro'), NOW)).toEqual({
      kind: 'queue',
      amountCents: 1900,
      creditCents: 0,
      listPriceCents: 1900,
      startsAt: current.periodEnd,
    });
  });

  it('queues annual → monthly on the same plan', () => {
    const current = entitlement({ cycle: 'annual', paidCents: 18_000 });

    expect(quoteChange(current, target('pro', 'monthly'), NOW)).toMatchObject({
      kind: 'queue',
      amountCents: 1900,
    });
  });
});

describe('applyPayment', () => {
  const paid = (
    plan: Plan,
    cycle: BillingCycle = 'monthly',
    listPriceCents = 1900,
  ) => ({
    plan,
    cycle,
    listPriceCents,
  });

  it('starts a period today for someone with nothing active', () => {
    const { entitlement: result, grant } = applyPayment(null, paid('pro'), NOW);

    expect(grant).toBe('started');
    expect(result).toEqual({
      plan: 'pro',
      cycle: 'monthly',
      periodStart: NOW,
      periodEnd: addDays(NOW, 30),
      paidCents: 1900,
      queued: null,
    });
  });

  it('gives an annual payment 365 days', () => {
    const { entitlement: result } = applyPayment(
      null,
      paid('pro', 'annual', 18_000),
      NOW,
    );

    expect(result.periodEnd).toEqual(addDays(NOW, 365));
    expect(result.paidCents).toBe(18_000);
  });

  it('starts fresh when the last period has already ended', () => {
    const lapsed = entitlement({
      periodEnd: addDays(NOW, -5),
      queued: { plan: 'business', cycle: 'monthly' },
    });

    const { entitlement: result, grant } = applyPayment(
      lapsed,
      paid('pro'),
      NOW,
    );

    expect(grant).toBe('started');
    expect(result.periodStart).toEqual(NOW);
    expect(result.queued).toBeNull();
  });

  it('adds the same plan again after the current period, and counts it as paid', () => {
    const current = entitlement();

    const { entitlement: result, grant } = applyPayment(
      current,
      paid('pro'),
      NOW,
    );

    expect(grant).toBe('extended');
    expect(result.periodStart).toEqual(current.periodStart);
    expect(result.periodEnd).toEqual(addDays(current.periodEnd, 30));
    expect(result.paidCents).toBe(3800);
  });

  it('switches to a bigger plan at once, for a whole new period', () => {
    const { entitlement: result, grant } = applyPayment(
      entitlement(),
      paid('business', 'monthly', 7900),
      NOW,
    );

    expect(grant).toBe('switched');
    expect(result).toMatchObject({
      plan: 'business',
      periodStart: NOW,
      periodEnd: addDays(NOW, 30),
      paidCents: 7900,
    });
  });

  it('keeps what was bought in advance when switching to a bigger plan', () => {
    const current = entitlement({ queued: { plan: 'pro', cycle: 'annual' } });

    const { entitlement: result } = applyPayment(
      current,
      paid('business', 'monthly', 7900),
      NOW,
    );

    expect(result.queued).toEqual({ plan: 'pro', cycle: 'annual' });
  });

  it('holds a smaller plan back until the current period ends', () => {
    const current = entitlement({ plan: 'business', paidCents: 7900 });

    const { entitlement: result, grant } = applyPayment(
      current,
      paid('pro'),
      NOW,
    );

    expect(grant).toBe('queued');
    expect(result.plan).toBe('business');
    expect(result.periodEnd).toEqual(current.periodEnd);
    expect(result.queued).toEqual({ plan: 'pro', cycle: 'monthly' });
  });

  it('looks at what the user has now, so a late payment for a stale quote still lands sensibly', () => {
    // Quoted as an upgrade Pro → Business, but they already switched to Business meanwhile.
    const already = entitlement({ plan: 'business', paidCents: 7900 });

    const { grant, entitlement: result } = applyPayment(
      already,
      paid('business', 'monthly', 7900),
      NOW,
    );

    expect(grant).toBe('extended');
    expect(result.periodEnd).toEqual(addDays(already.periodEnd, 30));
  });
});

describe('roll', () => {
  it('leaves an entitlement that is still running alone', () => {
    const current = entitlement();

    expect(roll(current, NOW)).toBe(current);
  });

  it('lapses to nothing when the period ends and nothing is queued', () => {
    expect(roll(entitlement({ periodEnd: addDays(NOW, -1) }), NOW)).toBeNull();
    expect(roll(entitlement({ periodEnd: NOW }), NOW)).toBeNull();
  });

  it('starts the queued plan the moment the current period ends', () => {
    const end = addDays(NOW, -1);
    const current = entitlement({
      plan: 'business',
      periodEnd: end,
      queued: { plan: 'pro', cycle: 'monthly' },
    });

    expect(roll(current, NOW)).toEqual({
      plan: 'pro',
      cycle: 'monthly',
      periodStart: end,
      periodEnd: addDays(end, 30),
      paidCents: 1900,
      queued: null,
    });
  });

  it('keeps going when the job ran so late that the queued period is over as well', () => {
    const current = entitlement({
      plan: 'business',
      periodEnd: addDays(NOW, -40),
      queued: { plan: 'pro', cycle: 'monthly' },
    });

    expect(roll(current, NOW)).toBeNull();
  });
});

describe('planEventKind', () => {
  it.each([
    ['free', 'pro', 'upgraded'],
    ['pro', 'business', 'upgraded'],
    ['free', 'business', 'upgraded'],
    ['business', 'pro', 'downgraded'],
    ['pro', 'free', 'canceled'],
    ['business', 'free', 'canceled'],
    ['pro', 'pro', null],
    ['free', 'free', null],
  ] as const)('%s → %s is %s', (before, after, expected) => {
    expect(planEventKind(before, after)).toBe(expected);
  });
});
