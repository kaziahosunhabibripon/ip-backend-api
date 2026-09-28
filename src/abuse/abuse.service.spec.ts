import { Logger } from '@nestjs/common';
import type { CacheService } from '../cache/cache.service';
import { AbuseService } from './abuse.service';
import type { AbuseStore } from './abuse-store.service';

beforeAll(() => Logger.overrideLogger(false));

const setup = (
  options: { counts?: number[]; blocked?: boolean; cacheFails?: boolean } = {},
) => {
  const counts = [...(options.counts ?? [])];
  const cache = {
    increment: jest.fn(() =>
      options.cacheFails
        ? Promise.reject(new Error('redis is down'))
        : Promise.resolve({ count: counts.shift() ?? 1, resetsInSeconds: 30 }),
    ),
  };
  const store = {
    raise: jest.fn(() => Promise.resolve()),
    isBlocked: jest.fn(() => Promise.resolve(options.blocked ?? false)),
    block: jest.fn(() => Promise.resolve()),
    unblock: jest.fn(() => Promise.resolve()),
  };
  const service = new AbuseService(
    cache as unknown as CacheService,
    store as unknown as AbuseStore,
  );
  return { service, cache, store };
};

describe('AbuseService.note', () => {
  it('counts in the shared cache, in the reason’s own window, per subject', async () => {
    const { service, cache } = setup();

    await service.note('api_key', 'key_1', 'rate_limited');

    expect(cache.increment).toHaveBeenCalledWith(
      'abuse:rate_limited:api_key:key_1',
      3600,
    );
  });

  it('writes nothing while the count is under the bar', async () => {
    const { service, store } = setup({ counts: [1, 2, 9] });

    await service.note('account', 'u_1', 'internal_targets');
    await service.note('account', 'u_1', 'internal_targets');
    await service.note('account', 'u_1', 'internal_targets');

    expect(store.raise).not.toHaveBeenCalled();
  });

  it('raises the flag when the count reaches the bar, with that count', async () => {
    const { service, store } = setup({ counts: [10] });

    await service.note('account', 'u_1', 'internal_targets');

    expect(store.raise).toHaveBeenCalledWith({
      kind: 'account',
      subjectKey: 'u_1',
      reason: 'internal_targets',
      events: 10,
    });
  });

  it('refreshes the flag every so often after that, not on every event', async () => {
    const { service, store } = setup({ counts: [11, 12, 20] });

    await service.note('account', 'u_1', 'internal_targets');
    await service.note('account', 'u_1', 'internal_targets');
    expect(store.raise).not.toHaveBeenCalled();

    await service.note('account', 'u_1', 'internal_targets');
    expect(store.raise).toHaveBeenCalledWith(
      expect.objectContaining({ events: 20 }),
    );
  });

  it('never throws, whatever goes wrong — it runs inside someone else’s request', async () => {
    const outage = setup({ cacheFails: true });
    await expect(
      outage.service.note('account', 'u_1', 'internal_targets'),
    ).resolves.toBeUndefined();

    const failing = setup({ counts: [10] });
    failing.store.raise.mockRejectedValueOnce(new Error('database down'));
    await expect(
      failing.service.note('account', 'u_1', 'internal_targets'),
    ).resolves.toBeUndefined();
  });
});

describe('AbuseService.isBlocked', () => {
  it('asks the database, then remembers the answer for a few seconds', async () => {
    const { service, store } = setup({ blocked: true });

    expect(await service.isBlocked('hash_1', 1_000)).toBe(true);
    expect(await service.isBlocked('hash_1', 5_000)).toBe(true);
    expect(store.isBlocked).toHaveBeenCalledTimes(1);

    expect(await service.isBlocked('hash_1', 1_000 + 16_000)).toBe(true);
    expect(store.isBlocked).toHaveBeenCalledTimes(2);
  });

  it('remembers "not blocked" too, so ordinary visitors do not cost a query each', async () => {
    const { service, store } = setup({ blocked: false });

    await service.isBlocked('hash_1', 1_000);
    await service.isBlocked('hash_1', 2_000);
    await service.isBlocked('hash_1', 3_000);

    expect(store.isBlocked).toHaveBeenCalledTimes(1);
  });

  it('lets a lookup through when the blocklist can not be read', async () => {
    const { service, store } = setup();
    store.isBlocked.mockRejectedValueOnce(new Error('database down'));

    await expect(service.isBlocked('hash_1', 1_000)).resolves.toBe(false);
  });

  it('takes effect at once on this instance when an administrator blocks or unblocks', async () => {
    const { service, store } = setup({ blocked: false });
    await service.isBlocked('hash_1', Date.now());

    await service.blockVisitor('hash_1', 'probing', 'admin_1');
    expect(store.block).toHaveBeenCalledWith('hash_1', 'probing', 'admin_1');
    expect(await service.isBlocked('hash_1')).toBe(true);

    await service.unblockVisitor('hash_1');
    expect(store.unblock).toHaveBeenCalledWith('hash_1');
    expect(await service.isBlocked('hash_1')).toBe(false);
  });
});
