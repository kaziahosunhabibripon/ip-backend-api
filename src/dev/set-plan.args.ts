import { PLAN_ORDER } from '../common/plans';
import type { Plan } from '../contracts';

export type SetPlanArgs =
  { ok: true; email: string; plan: Plan } | { ok: false; message: string };

export const USAGE = `Usage: npm run dev:set-plan -- <email> <${PLAN_ORDER.join('|')}>`;

/** `npm run dev:set-plan -- jane@company.com pro`. The email is trimmed and lowercased like every address here. */
export const parseSetPlanArgs = (argv: string[]): SetPlanArgs => {
  const [rawEmail, rawPlan, ...extra] = argv;
  const email = rawEmail?.trim().toLowerCase();
  const plan = rawPlan?.trim().toLowerCase();

  if (!email || !plan || extra.length > 0) {
    return { ok: false, message: USAGE };
  }
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    return {
      ok: false,
      message: `"${rawEmail}" doesn't look like an email address.\n${USAGE}`,
    };
  }
  if (!PLAN_ORDER.includes(plan as Plan)) {
    return {
      ok: false,
      message: `"${rawPlan}" is not a plan. Choose one of: ${PLAN_ORDER.join(', ')}.`,
    };
  }
  return { ok: true, email, plan: plan as Plan };
};
