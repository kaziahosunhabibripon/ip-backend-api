import { ApiKeyAuthService } from './api-key-auth.service';
import { generateApiKeySecret, hashApiKey } from './api-key-secret';
import type { ApiKeyRow, ApiKeysStore } from './api-keys-store.service';
import type { UserRow } from '../users/user.mapper';

const NOW = new Date('2026-09-24T12:00:00.000Z');
const MINUTE = 60_000;

const key = (overrides: Partial<ApiKeyRow> = {}): ApiKeyRow => ({
  id: 'key_1',
  userId: 'u_1',
  name: 'CI',
  prefix: 'ips_live_a1b2',
  secretHash: 'h',
  environment: 'production',
  status: 'active',
  createdAt: new Date(NOW.getTime() - 86_400_000),
  lastUsedAt: null,
  revokedAt: null,
  ...overrides,
});

const owner: UserRow = {
  id: 'u_1',
  name: 'Alex',
  email: 'alex@example.com',
  passwordHash: 'scrypt$secret-hash',
  plan: 'pro',
  role: 'user',
  emailVerified: true,
  notificationPreferences: {
    monitorAlerts: true,
    securityAlerts: true,
    weeklyDigest: false,
    usageWarnings: true,
    productUpdates: false,
  },
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const setup = (found?: { key: ApiKeyRow; owner: UserRow }) => {
  const store = {
    findActiveByHash: jest.fn(
      (): Promise<{ key: ApiKeyRow; owner: UserRow } | undefined> =>
        Promise.resolve(found),
    ),
    touch: jest.fn((): Promise<void> => Promise.resolve()),
  };
  return {
    store,
    service: new ApiKeyAuthService(store as unknown as ApiKeysStore),
  };
};

describe('ApiKeyAuthService.authenticate', () => {
  const secret = generateApiKeySecret('production');

  it('looks the key up by the hash of the secret, never by the secret', async () => {
    const { service, store } = setup({ key: key(), owner });

    await service.authenticate(secret, NOW);

    expect(store.findActiveByHash).toHaveBeenCalledWith(hashApiKey(secret));
  });

  it('returns the owner and which key it was — without the password hash', async () => {
    const { service } = setup({ key: key(), owner });

    const result = await service.authenticate(secret, NOW);

    expect(result?.key).toEqual({ id: 'key_1', environment: 'production' });
    expect(result?.user).toMatchObject({ id: 'u_1', plan: 'pro' });
    expect(JSON.stringify(result)).not.toContain('scrypt$secret-hash');
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('refuses a suspended owner with FORBIDDEN, and does not even record the use', async () => {
    const { service, store } = setup({
      key: key(),
      owner: {
        ...owner,
        suspendedAt: new Date('2026-09-25T00:00:00.000Z'),
        suspensionReason: 'scraping',
      },
    });

    await expect(service.authenticate(secret, NOW)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    expect(store.touch).not.toHaveBeenCalled();
  });

  it('is null for an unknown or revoked key', async () => {
    const { service } = setup(undefined);
    await expect(service.authenticate(secret, NOW)).resolves.toBeNull();
  });

  it('never touches the database for something that could not be a key', async () => {
    const { service, store } = setup({ key: key(), owner });

    for (const junk of ['', 'Bearer', 'a'.repeat(43), 'ips_live_short']) {
      await expect(service.authenticate(junk, NOW)).resolves.toBeNull();
    }
    expect(store.findActiveByHash).not.toHaveBeenCalled();
  });

  it('records the first use, and one that is over a minute after the last', async () => {
    const first = setup({ key: key({ lastUsedAt: null }), owner });
    await first.service.authenticate(secret, NOW);
    expect(first.store.touch).toHaveBeenCalledWith(
      'key_1',
      NOW,
      new Date(NOW.getTime() - MINUTE),
    );

    const stale = setup({
      key: key({ lastUsedAt: new Date(NOW.getTime() - 2 * MINUTE) }),
      owner,
    });
    await stale.service.authenticate(secret, NOW);
    expect(stale.store.touch).toHaveBeenCalledTimes(1);
  });

  it('does not write on every request: a use within the last minute is left alone', async () => {
    const { service, store } = setup({
      key: key({ lastUsedAt: new Date(NOW.getTime() - 10_000) }),
      owner,
    });

    await service.authenticate(secret, NOW);

    expect(store.touch).not.toHaveBeenCalled();
  });

  it('is not held up, or failed, by that bookkeeping', async () => {
    const { service, store } = setup({ key: key(), owner });
    store.touch.mockRejectedValueOnce(new Error('db hiccup'));

    await expect(service.authenticate(secret, NOW)).resolves.not.toBeNull();
    await new Promise((resolve) => setImmediate(resolve)); // the swallowed rejection must not surface
  });
});
