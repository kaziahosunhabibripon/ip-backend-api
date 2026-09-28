import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { AuthenticatedRequest } from '../types/authenticated-request.type';

/**
 * The per-IP throttle for browsers and anonymous callers. A request that authenticated with an API key
 * skips it: that caller is limited per key instead (`ApiKeyRateLimitGuard`), and many servers behind one
 * NAT address must not share a 20-a-minute allowance.
 */
@Injectable()
export class IpThrottlerGuard extends ThrottlerGuard {
  protected shouldSkip(context: ExecutionContext): Promise<boolean> {
    const { apiKey } = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>();
    return Promise.resolve(apiKey !== undefined);
  }
}
