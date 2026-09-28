import type { ConfigService } from '@nestjs/config';
import { BulkScheduler } from './bulk-scheduler.service';
import type { BulkRunner } from './bulk-runner.service';
import type { BulkStore, StoredJob } from './bulk-store.service';

const job = (id: string) => ({ id, userId: 'u' }) as StoredJob;

const build = (
  claims: (StoredJob | null)[],
  run: jest.Mock = jest.fn(() => Promise.resolve('finished')),
  env: Record<string, string> = {},
) => {
  const queue = [...claims];
  const store = {
    claimJob: jest.fn(() => Promise.resolve(queue.shift() ?? null)),
  };
  const config = { get: (k: string) => env[k] } as unknown as ConfigService;
  const scheduler = new BulkScheduler(
    store as unknown as BulkStore,
    { run } as unknown as BulkRunner,
    config,
  );
  return { scheduler, store, run };
};

describe('BulkScheduler', () => {
  it('keeps taking jobs until none is waiting', async () => {
    const { scheduler, run } = build([job('a'), job('b')]);
    await expect(scheduler.tick()).resolves.toBe(2);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does nothing when no job is waiting', async () => {
    const { scheduler, run } = build([]);
    await expect(scheduler.tick()).resolves.toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it('stops the pass on a failure instead of retrying in a loop', async () => {
    const run = jest.fn().mockRejectedValue(new Error('database down'));
    const { scheduler, store } = build([job('a'), job('b')], run);
    await expect(scheduler.tick()).resolves.toBe(1);
    expect(store.claimJob).toHaveBeenCalledTimes(1);
  });

  it('collapses overlapping ticks into one pass', async () => {
    let release: (v: string) => void = () => undefined;
    const run = jest.fn(
      () => new Promise<string>((resolve) => (release = resolve)),
    );
    const { scheduler, store } = build([job('a')], run);
    const first = scheduler.tick();
    const second = scheduler.tick();
    // Let the first pass reach the runner before it is released.
    await new Promise((resolve) => setImmediate(resolve));
    release('finished');
    await Promise.all([first, second]);
    expect(store.claimJob).toHaveBeenCalledTimes(2); // the job, then "none left"
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs a job with the shutdown flag wired in, and stops taking jobs once shut down', async () => {
    const seen: boolean[] = [];
    const run = jest.fn(
      (_job: StoredJob, _deadline: number, stop: () => boolean) => {
        seen.push(stop());
        return Promise.resolve('finished');
      },
    );
    const { scheduler, store } = build([job('a'), job('b')], run);
    await scheduler.tick();
    expect(seen).toEqual([false, false]);

    await scheduler.onApplicationShutdown();
    store.claimJob.mockClear();
    await scheduler.tick();
    expect(store.claimJob).not.toHaveBeenCalled();
  });

  it('schedules nothing when BULK_SCHEDULER_ENABLED=false', () => {
    jest.useFakeTimers();
    try {
      const { scheduler, store } = build([job('a')], undefined, {
        BULK_SCHEDULER_ENABLED: 'false',
      });
      scheduler.onApplicationBootstrap();
      jest.advanceTimersByTime(60_000);
      expect(store.claimJob).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
