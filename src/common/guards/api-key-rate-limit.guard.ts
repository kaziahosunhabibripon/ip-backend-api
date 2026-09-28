import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { AbuseService } from '../../abuse/abuse.service';
import { CacheService } from '../../cache/cache.service';
import { ApiException } from '../dto/api-exception';
import { apiRateLimit } from '../plans';
import type { AuthenticatedRequest } from '../types/authenticated-request.type';

const WINDOW_SECONDS = 60;

/**
 * Requests per minute for one API key (its owner's plan and the key's environment decide how many).
 * A fixed one-minute window, counted in the shared cache. Runs only for requests that AuthGuard
 * authenticated with a key — cookie and anonymous traffic has its own limits — and before any work
 * or quota is spent, so a request turned away here costs nothing.
 *
 * Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (epoch
 * seconds); a refusal is `429 RATE_LIMITED` with `retryAfterSeconds` (and a `Retry-After` header).
 */
@Injectable()
export class ApiKeyRateLimitGuard implements CanActivate {
  constructor(
    private readonly cache: CacheService,
    private readonly abuse: AbuseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const { apiKey, user } = http.getRequest<AuthenticatedRequest>();
    if (!apiKey || !user) {
      return true;
    }

    const limit = apiRateLimit(user.plan, apiKey.environment);
    const { count, resetsInSeconds } = await this.cache.increment(
      `ratelimit:key:${apiKey.id}`,
      WINDOW_SECONDS,
    );

    const response = http.getResponse<Response>();
    response.setHeader('X-RateLimit-Limit', String(limit));
    response.setHeader(
      'X-RateLimit-Remaining',
      String(Math.max(0, limit - count)),
    );
    response.setHeader(
      'X-RateLimit-Reset',
      String(Math.ceil(Date.now() / 1000) + resetsInSeconds),
    );

    if (count > limit) {
      // One request over the limit is a busy script; thousands an hour is one that ignores 429s.
      void this.abuse.note('api_key', apiKey.id, 'rate_limited');
      throw new ApiException(
        'RATE_LIMITED',
        `You're sending requests too quickly: this key allows ${limit} a minute.`,
        { retryAfterSeconds: resetsInSeconds, limitPerMinute: limit },
      );
    }
    return true;
  }
}
