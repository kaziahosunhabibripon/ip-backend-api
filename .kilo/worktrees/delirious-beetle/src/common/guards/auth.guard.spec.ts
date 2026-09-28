import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { ApiKeyAuthService } from '../../api-keys/api-key-auth.service';
import { generateApiKeySecret } from '../../api-keys/api-key-secret';
import type { SessionService } from '../../auth/session.service';
import type { CacheService } from '../../cache/cache.service';
import type { Plan, User } from '../../contracts';
import type { TeamsService } from '../../teams/teams.service';
import { ALLOWS_API_KEY } from '../decorators/allow-api-key.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { ApiException } from '../dto/api-exception';
import type { AuthenticatedRequest } from '../types/authenticated-request.type';
import { AuthGuard } from './auth.guard';

const user = (plan: Plan = 'pro'): User => ({
  id: 'u_1',
  name: 'Alex',
  email: 'alex@example.com',
  role: 'user',
  plan,
  effectivePlan: plan,
  emailVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
});

const secret = generateApiKeySecret('production');

const setup = (
  options: {
    allowsApiKey?: boolean;
    isPublic?: boolean;
    authorization?: string;
    cookie?: string;
    session?: boolean;
    key?: { plan: Plan } | null;
    badKeysThisMinute?: number;
    /** What `TeamsService.effectivePlan` should answer — defaults to "no elevation". */
    teamPlan?: (user: User) => Plan;
  } = {},
) => {
  const flags: Record<string, boolean | undefined> = {
    [ALLOWS_API_KEY]: options.allowsApiKey,
    [IS_PUBLIC_KEY]: options.isPublic,
  };
  const reflector = {
    getAllAndOverride: jest.fn((flag: string) => flags[flag]),
  };
  const sessions = {
    findActive: jest.fn(() =>
      Promise.resolve(
        options.session ? { sessionId: 's_1', user: user('free') } : null,
      ),
    ),
  };
  const apiKeys = {
    authenticate: jest.fn(() =>
      Promise.resolve(
        options.key
          ? {
              user: user(options.key.plan),
              key: { id: 'key_1', environment: 'production' as const },
            }
          : null,
      ),
    ),
  };
  const cache = {
    increment: jest.fn(() =>
      Promise.resolve({
        count: options.badKeysThisMinute ?? 1,
        resetsInSeconds: 42,
      }),
    ),
  };
  const teams = {
    effectivePlan: jest.fn((candidate: User) =>
      Promise.resolve(
        options.teamPlan ? options.teamPlan(candidate) : candidate.plan,
      ),
    ),
  };
  const request = {
    headers: { authorization: options.authorization },
    cookies: options.cookie ? { ipscope_session: options.cookie } : {},
    ip: '198.51.100.7',
  } as unknown as AuthenticatedRequest;
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;

  const guard = new AuthGuard(
    reflector as unknown as Reflector,
    sessions as unknown as SessionService,
    apiKeys as unknown as ApiKeyAuthService,
    cache as unknown as CacheService,
    teams as unknown as TeamsService,
  );
  return { guard, context, request, sessions, apiKeys, cache, teams };
};

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as ApiException;
  }
  throw new Error('expected a rejection');
};

describe('AuthGuard — cookies (unchanged)', () => {
  it('attaches the user of a valid session', async () => {
    const { guard, context, request } = setup({ cookie: 'tok', session: true });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(request.user?.id).toBe('u_1');
    expect(request.sessionId).toBe('s_1');
    expect(request.apiKey).toBeUndefined();
  });

  it('rejects an anonymous caller on a protected route', async () => {
    const { guard, context } = setup();
    expect((await errorOf(guard.canActivate(context))).code).toBe(
      'AUTH_REQUIRED',
    );
  });

  it('lets an anonymous caller through on a public route', async () => {
    const { guard, context, request } = setup({ isPublic: true });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });
});

describe('AuthGuard — team elevation', () => {
  it('enriches a cookie session’s user with what TeamsService says they may actually use', async () => {
    const { guard, context, request, teams } = setup({
      cookie: 'tok',
      session: true,
      teamPlan: () => 'business',
    });

    await guard.canActivate(context);

    expect(teams.effectivePlan).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u_1' }),
    );
    expect(request.user?.plan).toBe('free');
    expect(request.user?.effectivePlan).toBe('business');
  });

  it('resolves effective plan before deciding whether a key still has API access', async () => {
    const { guard, context, request } = setup({
      allowsApiKey: true,
      authorization: `Bearer ${secret}`,
      key: { plan: 'free' },
      teamPlan: () => 'business',
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user?.plan).toBe('free');
    expect(request.user?.effectivePlan).toBe('business');
  });
});

describe('AuthGuard — API keys', () => {
  it('authenticates a valid key on a route that allows keys', async () => {
    const { guard, context, request, apiKeys } = setup({
      allowsApiKey: true,
      isPublic: true,
      authorization: `Bearer ${secret}`,
      key: { plan: 'pro' },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(apiKeys.authenticate).toHaveBeenCalledWith(secret);
    expect(request.user?.plan).toBe('pro');
    expect(request.apiKey).toEqual({ id: 'key_1', environment: 'production' });
    expect(request.sessionId).toBeUndefined();
  });

  it('lets the key win when a cookie is sent as well', async () => {
    const { guard, context, request, sessions } = setup({
      allowsApiKey: true,
      isPublic: true,
      authorization: `Bearer ${secret}`,
      cookie: 'tok',
      session: true,
      key: { plan: 'business' },
    });

    await guard.canActivate(context);

    expect(sessions.findActive).not.toHaveBeenCalled();
    expect(request.user?.plan).toBe('business');
  });

  it('turns a bad or revoked key into 401, never into an anonymous request', async () => {
    const { guard, context, request } = setup({
      allowsApiKey: true,
      isPublic: true, // the route would happily serve an anonymous caller
      authorization: `Bearer ${secret}`,
      key: null,
    });

    const error = await errorOf(guard.canActivate(context));

    expect(error.code).toBe('AUTH_REQUIRED');
    expect(error.status).toBe(401);
    expect(error.message).toContain('invalid or has been revoked');
    expect(request.user).toBeUndefined();
  });

  it('refuses a key whose owner is no longer on a plan with API access', async () => {
    const { guard, context, request } = setup({
      allowsApiKey: true,
      isPublic: true,
      authorization: `Bearer ${secret}`,
      key: { plan: 'free' },
    });

    const error = await errorOf(guard.canActivate(context));

    expect(error.code).toBe('PLAN_REQUIRED');
    expect(error.details).toEqual({ requiredPlan: 'pro' });
    expect(request.user).toBeUndefined();
    expect(request.apiKey).toBeUndefined();
  });

  it('ignores the header on a route that does not accept keys, so a key can never reach account routes', async () => {
    const { guard, context, apiKeys, request } = setup({
      allowsApiKey: false,
      authorization: `Bearer ${secret}`,
      key: { plan: 'pro' },
    });

    const error = await errorOf(guard.canActivate(context));

    expect(error.code).toBe('AUTH_REQUIRED');
    expect(apiKeys.authenticate).not.toHaveBeenCalled();
    expect(request.user).toBeUndefined();
  });

  it('still serves a cookie session on a route that does not accept keys, even if a key header is present', async () => {
    const { guard, context, request } = setup({
      allowsApiKey: false,
      authorization: `Bearer ${secret}`,
      cookie: 'tok',
      session: true,
    });

    await guard.canActivate(context);

    expect(request.user?.id).toBe('u_1');
    expect(request.apiKey).toBeUndefined();
  });

  it('leaves other Authorization schemes alone', async () => {
    const { guard, context, apiKeys } = setup({
      allowsApiKey: true,
      isPublic: true,
      authorization: 'Basic dXNlcjpwYXNz',
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(apiKeys.authenticate).not.toHaveBeenCalled();
  });

  it('counts wrong keys per address and slows a caller who keeps guessing', async () => {
    const { guard, context, cache } = setup({
      allowsApiKey: true,
      isPublic: true,
      authorization: `Bearer ${secret}`,
      key: null,
      badKeysThisMinute: 31,
    });

    const error = await errorOf(guard.canActivate(context));

    expect(cache.increment).toHaveBeenCalledWith(
      'apikey-fail:198.51.100.7',
      60,
    );
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.details).toEqual({ retryAfterSeconds: 42 });
  });

  it('does not count a valid key as a failed attempt', async () => {
    const { guard, context, cache } = setup({
      allowsApiKey: true,
      isPublic: true,
      authorization: `Bearer ${secret}`,
      key: { plan: 'pro' },
    });

    await guard.canActivate(context);

    expect(cache.increment).not.toHaveBeenCalled();
  });
});
