import { PLAN_LIMITS, PLAN_ORDER } from '../common/plans';
import type { BillingCycle, Plan, PlanDefinition } from '../contracts';

/** The plans a customer can buy on their own. Free needs no payment and Enterprise is arranged with sales. */
export type PaidPlan = 'pro' | 'business';
export const PAID_PLANS: readonly PaidPlan[] = ['pro', 'business'];

export const isPaidPlan = (plan: Plan): plan is PaidPlan =>
  PAID_PLANS.includes(plan as PaidPlan);

/**
 * US dollars per month, when billed monthly and when billed annually (charged as twelve months at once).
 * `ipscope-web` shows the same numbers on its pricing page; a test pins them so the two can't drift silently.
 */
const PRICES: Record<PaidPlan, { monthly: number; annualMonthly: number }> = {
  pro: { monthly: 19, annualMonthly: 15 },
  business: { monthly: 79, annualMonthly: 63 },
};

/** What one billing cycle costs, in cents — the amount an invoice for a full period asks for. */
export const unitAmountCents = (plan: PaidPlan, cycle: BillingCycle): number =>
  cycle === 'annual'
    ? PRICES[plan].annualMonthly * 12 * 100
    : PRICES[plan].monthly * 100;

export const PLAN_CATALOG: PlanDefinition[] = PLAN_ORDER.map(
  (id): PlanDefinition => {
    const limits = PLAN_LIMITS[id];
    switch (id) {
      case 'free':
        return {
          id,
          name: 'Free',
          tagline: 'For the occasional check.',
          priceMonthly: 0,
          priceAnnualMonthly: 0,
          cta: 'Create free account',
          features: [
            'Basic lookup',
            'DNS records',
            'Basic intelligence',
            'Saved history',
            'Limited usage: 100 lookups a month',
          ],
          limits,
        };
      case 'pro':
        return {
          id,
          name: 'Pro',
          tagline: 'For people who look at IPs every day.',
          priceMonthly: PRICES.pro.monthly,
          priceAnnualMonthly: PRICES.pro.annualMonthly,
          highlighted: true,
          badge: 'Most popular',
          cta: 'Start with Pro',
          features: [
            'Advanced intelligence',
            'Security signals',
            'Bulk lookup',
            'CSV and JSON export',
            'API access',
            '500 lookups a month',
          ],
          limits,
        };
      case 'business':
        return {
          id,
          name: 'Business',
          tagline: 'For teams that watch a lot of domains.',
          priceMonthly: PRICES.business.monthly,
          priceAnnualMonthly: PRICES.business.annualMonthly,
          cta: 'Choose Business',
          features: [
            'High-volume API',
            'Monitoring',
            'Alerts',
            'Teams',
            'Usage analytics',
            '5,000 lookups a month',
          ],
          limits,
        };
      default:
        return {
          id,
          name: 'Enterprise',
          tagline: 'Custom limits, SSO and an SLA.',
          priceMonthly: null,
          priceAnnualMonthly: null,
          cta: 'Contact sales',
          features: [
            'Custom limits',
            'SLA',
            'Custom integrations',
            'Dedicated support',
          ],
          limits,
        };
    }
  },
);
