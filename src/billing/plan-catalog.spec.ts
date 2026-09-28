import { PLAN_LIMITS, PLAN_ORDER } from '../common/plans';
import { PLAN_CATALOG, isPaidPlan, unitAmountCents } from './plan-catalog';

describe('plan prices', () => {
  // ipscope-web's pricing page shows $19 / $15 and $79 / $63 a month. Change both together or not at all.
  it('charges what the pricing page advertises', () => {
    expect(unitAmountCents('pro', 'monthly')).toBe(1_900);
    expect(unitAmountCents('pro', 'annual')).toBe(18_000);
    expect(unitAmountCents('business', 'monthly')).toBe(7_900);
    expect(unitAmountCents('business', 'annual')).toBe(75_600);
  });

  it('sells Pro and Business only', () => {
    expect(isPaidPlan('pro')).toBe(true);
    expect(isPaidPlan('business')).toBe(true);
    expect(isPaidPlan('free')).toBe(false);
    expect(isPaidPlan('enterprise')).toBe(false);
  });
});

describe('PLAN_CATALOG', () => {
  it('lists every plan once, cheapest first', () => {
    expect(PLAN_CATALOG.map((plan) => plan.id)).toEqual(PLAN_ORDER);
  });

  it('carries the enforced limits, so the pricing page and the server cannot disagree', () => {
    for (const plan of PLAN_CATALOG) {
      expect(plan.limits).toEqual(PLAN_LIMITS[plan.id]);
    }
  });

  it('prices free at nothing and enterprise as "talk to sales"', () => {
    const byId = Object.fromEntries(PLAN_CATALOG.map((p) => [p.id, p]));
    expect(byId.free.priceMonthly).toBe(0);
    expect(byId.pro.priceMonthly).toBe(19);
    expect(byId.pro.priceAnnualMonthly).toBe(15);
    expect(byId.business.priceMonthly).toBe(79);
    expect(byId.business.priceAnnualMonthly).toBe(63);
    expect(byId.enterprise.priceMonthly).toBeNull();
  });
});
