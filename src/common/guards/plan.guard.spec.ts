import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Plan, User } from '../../contracts';
import { ApiException } from '../dto/api-exception';
import { PlanGuard, REQUIRED_PLAN_KEY } from './plan.guard';

const contextFor = (
  user: Partial<User> | undefined,
  requiredPlan: Plan | undefined,
) => {
  const reflector = new Reflector();
  jest
    .spyOn(reflector, 'getAllAndOverride')
    .mockImplementation((key) =>
      key === REQUIRED_PLAN_KEY ? requiredPlan : undefined,
    );
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;

  return { guard: new PlanGuard(reflector), context };
};

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as ApiException).code;
  }
  return undefined;
};

describe('PlanGuard', () => {
  it('lets any request through when the route declares no required plan', () => {
    const { guard, context } = contextFor(undefined, undefined);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows a user whose plan meets the requirement', () => {
    const { guard, context } = contextFor(
      { plan: 'business', effectivePlan: 'business' },
      'pro',
    );
    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejects a lower plan with PLAN_REQUIRED', () => {
    const { guard, context } = contextFor(
      { plan: 'free', effectivePlan: 'free' },
      'pro',
    );
    expect(codeOf(() => guard.canActivate(context))).toBe('PLAN_REQUIRED');
  });

  it('goes by effectivePlan, not the account’s own plan — a Free account riding a Business team seat passes', () => {
    const { guard, context } = contextFor(
      { plan: 'free', effectivePlan: 'business' },
      'pro',
    );
    expect(guard.canActivate(context)).toBe(true);
  });

  it('still refuses when only the account’s own plan (never effectivePlan) happens to be high enough', () => {
    const { guard, context } = contextFor(
      { plan: 'business', effectivePlan: 'free' },
      'pro',
    );
    expect(codeOf(() => guard.canActivate(context))).toBe('PLAN_REQUIRED');
  });

  it('rejects a missing user with AUTH_REQUIRED', () => {
    const { guard, context } = contextFor(undefined, 'pro');
    expect(codeOf(() => guard.canActivate(context))).toBe('AUTH_REQUIRED');
  });
});
