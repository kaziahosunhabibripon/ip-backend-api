import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import type { Plan } from '../../contracts';
import { PlanGuard, REQUIRED_PLAN_KEY } from '../guards/plan.guard';

/**
 * Route needs this plan or higher; otherwise responds 403 PLAN_REQUIRED. Attaches PlanGuard itself,
 * so it always runs after the global AuthGuard has resolved the user.
 */
export const RequiresPlan = (plan: Plan) =>
  applyDecorators(SetMetadata(REQUIRED_PLAN_KEY, plan), UseGuards(PlanGuard));
