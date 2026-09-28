import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ApiException } from '../dto/api-exception';
import type { AuthenticatedRequest } from '../types/authenticated-request.type';

/** Use as `@UseGuards(AdminGuard)` on admin controllers (Phase 7). Runs after the global AuthGuard. */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!user) {
      throw new ApiException('AUTH_REQUIRED', 'Log in to continue.');
    }

    if (user.role !== 'admin') {
      throw new ApiException('FORBIDDEN', "You don't have access to this.");
    }

    return true;
  }
}
