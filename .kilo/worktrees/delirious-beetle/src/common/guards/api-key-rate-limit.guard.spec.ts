import type { ExecutionContext } from '@nestjs/common';
import type { AbuseService } from '../../abuse/abuse.service';
import type { CacheService } from '../../cache/cache.service';
import type { Plan, User } from '../../contracts';
import type { ApiException } from '../dto/api-exception';
import type { AuthenticatedRequest } from '../types/authenticated-request.type';
import { ApiKeyRateLimitGuard } from './api-key-rate-limit.guard';
import { IpThrottlerGuard } from './ip-throttler.guard';

const setup = (
  options: {
    key?: { id: string; environment: 'production' | 'development' };
    plan?: Plan;
    count?: number;
  } = {},
) => {
  const cache = {
    increment: jest.fn(() =>
      Promise.resolve({ count: options.count ?? 1, resetsInSeconds: 37 }),
    ),
  };
  const headers: Record<string, string> = {};
  const request = {
    apiKey: options.key,
    user: options.key
      ? ({ id: 'u_1', plan: options.plan ?? 'pro' } as User)
      : undefined,
  } as unknown as AuthenticatedRequest;
  const response = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
  };
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
  const abuse = { note: jest.fn(() => Promise.resolve()) };
  const guard = new ApiKeyRateLimitGuard(
    cache as unknown as CacheService,
    abuse as unknown as AbuseService,
  );
  return { guard, context, cache, headers, abuse };
};

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as ApiException;
  }
  throw new Error('expected a rejection');
};

describe('ApiKeyRateLimitGuard', () => {
  const production = { id: 'key_1', environment: 'production' as const };

  it('does nothing for a request that did not use a key', async () => {
    const { guard, context, cache } = setup();

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(cache.increment).not.toHaveBeenCalled();
  });

  it('counts per key in one-minute windows', async () => {
    const { guard, context, cache } = setup({ key: production });

    await guard.canActivate(context);

    expect(cache.increment).toHaveBeenCalledWith('ratelimit:key:key_1', 60);
  });

  it('lets a request through under the limit and describes what is left in headers', async () => {
    const { guard, context, headers } = setup({ key: production, count: 10 });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(headers['X-RateLimit-Limit']).toBe('1000');
    expect(headers['X-RateLimit-Remaining']).toBe('990');
    const reset = Number(headers['X-RateLimit-Reset']);
    expect(reset).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(reset).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000) + 37);
  });

  it('allows exactly the limit and refuses the next request', async () => {
    const atLimit = setup({ key: production, count: 1000 });
    await expect(atLimit.guard.canActivate(atLimit.context)).resolves.toBe(
      true,
    );
    expect(atLimit.headers['X-RateLimit-Remaining']).toBe('0');

    const over = setup({ key: production, count: 1001 });
    const error = await errorOf(over.guard.canActivate(over.context));
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.status).toBe(429);
    expect(error.details).toEqual({
      retryAfterSeconds: 37,
      limitPerMinute: 1000,
    });
    expect(over.headers['X-RateLimit-Remaining']).toBe('0'); // never negative
  });

  it('notes a refused request against the key, and only a refused one', async () => {
    const under = setup({ key: production, count: 1000 });
    await under.guard.canActivate(under.context);
    expect(under.abuse.note).not.toHaveBeenCalled();

    const over = setup({ key: production, count: 1001 });
    await errorOf(over.guard.canActivate(over.context));
    expect(over.abuse.note).toHaveBeenCalledWith(
      'api_key',
      'key_1',
      'rate_limited',
    );
  });

  it('follows the plan for production keys', async () => {
    const business = setup({ key: production, plan: 'business', count: 4000 });
    await expect(business.guard.canActivate(business.context)).resolves.toBe(
      true,
    );
    expect(business.headers['X-RateLimit-Limit']).toBe('5000');
  });

  it('keeps development keys at 100 a minute whatever the plan', async () => {
    const dev = setup({
      key: { id: 'key_2', environment: 'development' },
      plan: 'enterprise',
      count: 101,
    });

    const error = await errorOf(dev.guard.canActivate(dev.context));

    expect(error.code).toBe('RATE_LIMITED');
    expect(dev.headers['X-RateLimit-Limit']).toBe('100');
  });
});

describe('IpThrottlerGuard', () => {
  const skips = (request: Partial<AuthenticatedRequest>) => {
    const guard = Object.create(IpThrottlerGuard.prototype) as {
      shouldSkip(context: ExecutionContext): Promise<boolean>;
    };
    return guard.shouldSkip({
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext);
  };

  it('skips the per-IP throttle for a request that authenticated with a key, which has its own limit', async () => {
    await expect(
      skips({ apiKey: { id: 'key_1', environment: 'production' } }),
    ).resolves.toBe(true);
  });

  it('keeps throttling everyone else by IP', async () => {
    await expect(skips({})).resolves.toBe(false);
    await expect(skips({ user: { id: 'u_1' } as User })).resolves.toBe(false);
  });
});
