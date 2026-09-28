import type { ConfigService } from '@nestjs/config';
import { CacheService } from './cache.service';

// No REDIS_* settings -> the in-memory path, which is also what runs when Redis is unreachable.
const memoryOnly = () =>
  new CacheService({ get: () => undefined } as unknown as ConfigService);

describe('CacheService (in-memory mode)', () => {
  it('returns what was stored, with its age', async () => {
    const cache = memoryOnly();
    await cache.set('k', { a: 1 }, 60);

    const hit = await cache.get<{ a: number }>('k');
    expect(hit?.value).toEqual({ a: 1 });
    expect(hit?.ageSeconds).toBe(0);
  });

  it('misses for unknown keys', async () => {
    await expect(memoryOnly().get('nope')).resolves.toBeNull();
  });

  it('expires entries after their TTL', async () => {
    jest.useFakeTimers();
    try {
      const cache = memoryOnly();
      await cache.set('k', 'v', 10);
      jest.setSystemTime(Date.now() + 9_000);
      await expect(cache.get('k')).resolves.toMatchObject({ value: 'v' });
      jest.setSystemTime(Date.now() + 2_000);
      await expect(cache.get('k')).resolves.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports how old an entry is', async () => {
    jest.useFakeTimers();
    try {
      const cache = memoryOnly();
      await cache.set('k', 'v', 600);
      jest.setSystemTime(Date.now() + 42_000);
      await expect(cache.get('k')).resolves.toMatchObject({ ageSeconds: 42 });
    } finally {
      jest.useRealTimers();
    }
  });

  describe('increment (rate-limit counters)', () => {
    const at = (iso: string) => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date(iso));
    };
    afterEach(() => jest.useRealTimers());

    it('counts up within a window and says how long until it rolls over', async () => {
      at('2026-09-24T12:00:10.000Z');
      const cache = memoryOnly();

      expect(await cache.increment('rate:k', 60)).toEqual({
        count: 1,
        resetsInSeconds: 50,
      });
      expect(await cache.increment('rate:k', 60)).toEqual({
        count: 2,
        resetsInSeconds: 50,
      });
      jest.setSystemTime(new Date('2026-09-24T12:00:58.000Z'));
      expect(await cache.increment('rate:k', 60)).toEqual({
        count: 3,
        resetsInSeconds: 2,
      });
    });

    it('starts again from one in the next window', async () => {
      at('2026-09-24T12:00:59.000Z');
      const cache = memoryOnly();
      await cache.increment('rate:k', 60);
      await cache.increment('rate:k', 60);

      jest.setSystemTime(new Date('2026-09-24T12:01:00.000Z'));

      expect((await cache.increment('rate:k', 60)).count).toBe(1);
    });

    it('keeps separate keys apart', async () => {
      at('2026-09-24T12:00:10.000Z');
      const cache = memoryOnly();
      await cache.increment('rate:a', 60);
      await cache.increment('rate:a', 60);

      expect((await cache.increment('rate:b', 60)).count).toBe(1);
    });

    it('never reports less than one second to go', async () => {
      at('2026-09-24T12:00:59.999Z');
      expect((await memoryOnly().increment('rate:k', 60)).resetsInSeconds).toBe(
        1,
      );
    });
  });

  it('keeps null and falsy values distinguishable from a miss', async () => {
    const cache = memoryOnly();
    await cache.set('zero', 0, 60);
    await cache.set('empty', [], 60);
    await expect(cache.get('zero')).resolves.toMatchObject({ value: 0 });
    await expect(cache.get('empty')).resolves.toMatchObject({ value: [] });
  });
});
