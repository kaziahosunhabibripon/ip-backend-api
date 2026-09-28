import type { Plan, User } from '../contracts';
import type { ApiException } from '../common/dto/api-exception';
import { hashApiKey } from './api-key-secret';
import type {
  ApiKeyRow,
  ApiKeysStore,
  CreateKeyOutcome,
  NewApiKey,
} from './api-keys-store.service';
import {
  ApiKeysService,
  MAX_KEYS_PER_USER,
  toApiKey,
} from './api-keys.service';

const AT = new Date('2026-09-24T12:00:00.000Z');

const row = (overrides: Partial<ApiKeyRow> = {}): ApiKeyRow => ({
  id: 'key_1',
  userId: 'u_1',
  name: 'CI pipeline',
  prefix: 'ips_live_a1b2',
  secretHash: 'a'.repeat(64),
  environment: 'production',
  status: 'active',
  createdAt: AT,
  lastUsedAt: null,
  revokedAt: null,
  ...overrides,
});

const user = (plan: Plan = 'pro'): User =>
  ({ id: 'u_1', plan, email: 'a@example.com' }) as unknown as User;

describe('toApiKey', () => {
  it('shows everything except the secret and its hash', () => {
    const key = toApiKey(row({ lastUsedAt: AT }), 'pro');

    expect(key).toEqual({
      id: 'key_1',
      name: 'CI pipeline',
      environment: 'production',
      prefix: 'ips_live_a1b2',
      status: 'active',
      createdAt: AT.toISOString(),
      lastUsedAt: AT.toISOString(),
      rateLimit: 1000,
    });
    expect(JSON.stringify(key)).not.toContain('secretHash');
    expect(JSON.stringify(key)).not.toContain('a'.repeat(64));
  });

  it('reports a never-used key as null', () => {
    expect(toApiKey(row(), 'pro').lastUsedAt).toBeNull();
  });

  it('marks a revoked key', () => {
    expect(toApiKey(row({ status: 'revoked' }), 'pro').status).toBe('revoked');
  });

  it('works the rate limit out from the plan now, so an upgrade reaches existing keys', () => {
    expect(toApiKey(row(), 'pro').rateLimit).toBe(1000);
    expect(toApiKey(row(), 'business').rateLimit).toBe(5000);
    expect(toApiKey(row(), 'enterprise').rateLimit).toBe(5000);
  });

  it('keeps development keys small on every plan', () => {
    for (const plan of ['pro', 'business', 'enterprise'] as const) {
      expect(
        toApiKey(row({ environment: 'development' }), plan).rateLimit,
      ).toBe(100);
    }
  });
});

const setup = (outcome?: CreateKeyOutcome) => {
  const created: { userId: string; input: NewApiKey; cap: number }[] = [];
  const store = {
    list: jest.fn((): Promise<ApiKeyRow[]> => Promise.resolve([row()])),
    create: jest.fn(
      (
        userId: string,
        input: NewApiKey,
        cap: number,
      ): Promise<CreateKeyOutcome> => {
        created.push({ userId, input, cap });
        return Promise.resolve(
          outcome ?? {
            status: 'created',
            key: row({
              name: input.name,
              prefix: input.prefix,
              secretHash: input.secretHash,
              environment: input.environment,
            }),
          },
        );
      },
    ),
    revoke: jest.fn((): Promise<ApiKeyRow | undefined> =>
      Promise.resolve(row({ status: 'revoked', revokedAt: AT })),
    ),
    remove: jest.fn((): Promise<boolean> => Promise.resolve(true)),
  };
  const service = new ApiKeysService(store as unknown as ApiKeysStore);
  return { service, store, created };
};

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as ApiException;
  }
  throw new Error('expected a rejection');
};

describe('ApiKeysService.create', () => {
  it('returns the secret once, and stores only its hash and a short prefix', async () => {
    const { service, created } = setup();

    const { key, secret } = await service.create(user(), {
      name: 'CI pipeline',
      environment: 'production',
    });

    expect(secret).toMatch(/^ips_live_[A-Za-z0-9_-]{43}$/);
    expect(created).toHaveLength(1);
    const stored = created[0].input;
    expect(stored.secretHash).toBe(hashApiKey(secret));
    expect(stored.prefix).toBe(secret.slice(0, 13));
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(key.prefix).toBe(secret.slice(0, 13));
    expect(JSON.stringify(key)).not.toContain(secret);
  });

  it('makes development keys test keys', async () => {
    const { service } = setup();

    const { key, secret } = await service.create(user(), {
      name: 'Local',
      environment: 'development',
    });

    expect(secret.startsWith('ips_test_')).toBe(true);
    expect(key.environment).toBe('development');
    expect(key.rateLimit).toBe(100);
  });

  it('trims the name', async () => {
    const { service, created } = setup();

    await service.create(user(), {
      name: '   Production   ',
      environment: 'production',
    });

    expect(created[0].input.name).toBe('Production');
  });

  it('rejects a name that is only whitespace, without generating anything', async () => {
    const { service, store } = setup();

    const error = await errorOf(
      service.create(user(), { name: '   ', environment: 'production' }),
    );

    expect(error.code).toBe('INVALID_INPUT');
    expect(store.create).not.toHaveBeenCalled();
  });

  it('gives every key a different secret', async () => {
    const { service } = setup();
    const input = { name: 'k', environment: 'production' as const };

    const [a, b] = await Promise.all([
      service.create(user(), input),
      service.create(user(), input),
    ]);

    expect(a.secret).not.toBe(b.secret);
  });

  it('asks the store to enforce the cap, and reports CONFLICT when it is reached', async () => {
    const { service, created } = setup({ status: 'limit' });

    const error = await errorOf(
      service.create(user(), { name: 'one more', environment: 'production' }),
    );

    expect(created[0].cap).toBe(MAX_KEYS_PER_USER);
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toContain(String(MAX_KEYS_PER_USER));
  });
});

describe('ApiKeysService.list / revoke / remove', () => {
  it('lists keys with the owner’s plan applied', async () => {
    const { service } = setup();

    const keys = await service.list(user('business'));

    expect(keys).toHaveLength(1);
    expect(keys[0].rateLimit).toBe(5000);
  });

  it('revokes and returns the key as revoked', async () => {
    const { service, store } = setup();

    const key = await service.revoke(user(), 'key_1');

    expect(store.revoke).toHaveBeenCalledWith('u_1', 'key_1', expect.any(Date));
    expect(key.status).toBe('revoked');
  });

  it('answers NOT_FOUND for a key that is missing or someone else’s', async () => {
    const { service, store } = setup();
    store.revoke.mockResolvedValueOnce(undefined);
    store.remove.mockResolvedValueOnce(false);

    expect((await errorOf(service.revoke(user(), 'nope'))).code).toBe(
      'NOT_FOUND',
    );
    expect((await errorOf(service.remove(user(), 'nope'))).code).toBe(
      'NOT_FOUND',
    );
  });

  it('deletes a key', async () => {
    const { service, store } = setup();
    await service.remove(user(), 'key_1');
    expect(store.remove).toHaveBeenCalledWith('u_1', 'key_1');
  });
});
