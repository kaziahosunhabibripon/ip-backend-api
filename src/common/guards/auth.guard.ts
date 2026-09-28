import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { bearerTokenOf } from '../../api-keys/api-key-secret';
import { ApiKeyAuthService } from '../../api-keys/api-key-auth.service';
import { CacheService } from '../../cache/cache.service';
import { SESSION_COOKIE_NAME } from '../../auth/session-cookie';
import { SessionService } from '../../auth/session.service';
import { TeamsService } from '../../teams/teams.service';
import { ALLOWS_API_KEY } from '../decorators/allow-api-key.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ApiException } from '../dto/api-exception';
import { canAccess, requiredPlan, tierOf } from '../features';
import type { AuthenticatedRequest } from '../types/authenticated-request.type';

/** Wrong keys tried from one address in a minute before it is told to slow down — a bound on guessing, and on database lookups for junk. */
const MAX_BAD_KEYS_PER_MINUTE = 30;

/**
 * Registered globally: every route needs a valid `ipscope_session` cookie unless it's marked
 * `@Public()`. On a public route a valid session is still attached, so handlers can tell
 * signed-in viewers from anonymous ones.
 *
 * Routes marked `@AllowApiKey()` also accept `Authorization: Bearer ips_…`. A request that sends
 * a bearer token there has chosen key authentication: a bad or revoked key is a 401, never a quiet
 * fall-back to anonymous (which would spend a stranger's daily quota and hide the mistake). On every
 * other route the header is ignored.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly apiKeys: ApiKeyAuthService,
    private readonly cache: CacheService,
    private readonly teams: TeamsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const allowsApiKey = this.reflector.getAllAndOverride<boolean | undefined>(
      ALLOWS_API_KEY,
      [context.getHandler(), context.getClass()],
    );
    const secret = allowsApiKey
      ? bearerTokenOf(request.headers.authorization)
      : undefined;
    if (secret !== undefined) {
      await this.authenticateKey(request, secret);
      return true;
    }

    const cookies = request.cookies as
      Record<string, string | undefined> | undefined;
    const token = cookies?.[SESSION_COOKIE_NAME];

    const active = token ? await this.sessions.findActive(token) : null;
    if (active) {
      active.user.effectivePlan = await this.teams.effectivePlan(active.user);
      request.user = active.user;
      request.sessionId = active.sessionId;
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) {
      return true;
    }

    throw new ApiException('AUTH_REQUIRED', 'Log in to continue.');
  }

  private async authenticateKey(request: AuthenticatedRequest, secret: string) {
    const found = await this.apiKeys.authenticate(secret);
    if (!found) {
      const { count, resetsInSeconds } = await this.cache.increment(
        `apikey-fail:${request.ip ?? 'unknown'}`,
        60,
      );
      if (count > MAX_BAD_KEYS_PER_MINUTE) {
        throw new ApiException(
          'RATE_LIMITED',
          'Too many requests with an invalid API key. Try again shortly.',
          { retryAfterSeconds: resetsInSeconds },
        );
      }
      throw new ApiException(
        'AUTH_REQUIRED',
        'That API key is invalid or has been revoked.',
      );
    }

    found.user.effectivePlan = await this.teams.effectivePlan(found.user);

    // Keys outlive a downgrade; what they may do does not.
    if (!canAccess(tierOf(found.user), 'apiAccess')) {
      throw new ApiException(
        'PLAN_REQUIRED',
        'API access needs the Pro plan or higher.',
        { requiredPlan: requiredPlan('apiAccess') },
      );
    }

    request.user = found.user;
    request.apiKey = found.key;
  }
}
