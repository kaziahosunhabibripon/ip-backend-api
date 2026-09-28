import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Plan } from '../../contracts';
import { ApiException } from '../dto/api-exception';
import { planIncludes } from '../plans';
import type { AuthenticatedRequest } from '../types/authenticated-request.type';

export const REQUIRED_PLAN_KEY = 'requiredPlan';

/** Enforces `@RequiresPlan('pro')`. Runs after the global AuthGuard, so `request.user` is already resolved. */
@Injectable()
export class PlanGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Plan | undefined>(
      REQUIRED_PLAN_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!user) {
      throw new ApiException('AUTH_REQUIRED', 'Log in to continue.');
    }

    if (!planIncludes(user.effectivePlan, required)) {
      throw new ApiException(
        'PLAN_REQUIRED',
        `This feature needs the ${required} plan or higher.`,
        { requiredPlan: required },
      );
    }

    return true;
  }
}
