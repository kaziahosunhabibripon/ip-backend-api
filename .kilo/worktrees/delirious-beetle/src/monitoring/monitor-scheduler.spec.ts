import type { ConfigService } from '@nestjs/config';
import type { MonitorRunner } from './monitor-runner.service';
import { MonitorScheduler } from './monitor-scheduler.service';
import type { MonitorRow, MonitorStore } from './monitor-store.service';

const row = (id: string): MonitorRow =>
  ({ id, target: `${id}.example.com` }) as MonitorRow;

const setup = (env: Record<string, string> = {}) => {
  const claimDue = jest.fn((): Promise<MonitorRow[]> =>
    Promise.resolve([row('a'), row('b')]),
  );
  const run = jest.fn((): Promise<void> => Promise.resolve());
  const scheduler = new MonitorScheduler(
    { claimDue } as unknown as MonitorStore,
    { run } as unknown as MonitorRunner,
    { get: (key: string) => env[key] } as unknown as ConfigService,
  );
  return { scheduler, claimDue, run };
};

describe('MonitorScheduler.tick', () => {
  it('claims what is due and runs each monitor', async () => {
    const { scheduler, claimDue, run } = setup();
    const now = new Date('2026-09-24T12:00:00.000Z');

    await expect(scheduler.tick(now)).resolves.toBe(2);

    expect(claimDue).toHaveBeenCalledWith(now, 25, 3 * 60_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('keeps going when one monitor blows up', async () => {
    const { scheduler, run } = setup();
    run.mockRejectedValueOnce(new Error('boom'));

    await expect(scheduler.tick()).resolves.toBe(2);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('runs nothing, and does not throw, when it cannot look for due monitors', async () => {
    const { scheduler, claimDue, run } = setup();
    claimDue.mockRejectedValueOnce(new Error('db down'));

    await expect(scheduler.tick()).resolves.toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it('folds overlapping ticks into the one already running', async () => {
    const { scheduler, claimDue } = setup();

    const [first, second] = await Promise.all([
      scheduler.tick(),
      scheduler.tick(),
    ]);

    expect(claimDue).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it('can tick again once the previous tick has finished', async () => {
    const { scheduler, claimDue } = setup();
    await scheduler.tick();
    await scheduler.tick();
    expect(claimDue).toHaveBeenCalledTimes(2);
  });

  it('never runs more than five monitors at once', async () => {
    const { scheduler, claimDue, run } = setup();
    claimDue.mockResolvedValueOnce(
      Array.from({ length: 12 }, (_, i) => row(`m${i}`)),
    );
    let active = 0;
    let peak = 0;
    run.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });

    await scheduler.tick();

    expect(run).toHaveBeenCalledTimes(12);
    expect(peak).toBe(5);
  });
});

describe('MonitorScheduler lifecycle', () => {
  it('does not schedule anything when MONITORING_ENABLED is false', () => {
    jest.useFakeTimers();
    try {
      const { scheduler, claimDue } = setup({ MONITORING_ENABLED: 'false' });
      scheduler.onApplicationBootstrap();
      jest.advanceTimersByTime(10 * 60_000);
      expect(claimDue).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('ticks on the configured interval and stops on shutdown', async () => {
    jest.useFakeTimers();
    try {
      const { scheduler, claimDue } = setup({ MONITORING_TICK_SECONDS: '30' });
      scheduler.onApplicationBootstrap();

      await jest.advanceTimersByTimeAsync(30_000);
      expect(claimDue).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(30_000);
      expect(claimDue).toHaveBeenCalledTimes(2);

      await scheduler.onApplicationShutdown();
      await jest.advanceTimersByTimeAsync(120_000);
      expect(claimDue).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('falls back to a minute when the interval setting is nonsense', async () => {
    jest.useFakeTimers();
    try {
      const { scheduler, claimDue } = setup({
        MONITORING_TICK_SECONDS: 'soon',
      });
      scheduler.onApplicationBootstrap();

      await jest.advanceTimersByTimeAsync(59_000);
      expect(claimDue).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1_000);
      expect(claimDue).toHaveBeenCalledTimes(1);
      await scheduler.onApplicationShutdown();
    } finally {
      jest.useRealTimers();
    }
  });

  it('waits for the tick in progress before shutdown completes', async () => {
    const { scheduler, claimDue } = setup();
    let release!: () => void;
    claimDue.mockReturnValueOnce(
      new Promise<MonitorRow[]>((resolve) => {
        release = () => resolve([]);
      }),
    );

    const ticking = scheduler.tick();
    let stopped = false;
    const stopping = scheduler.onApplicationShutdown().then(() => {
      stopped = true;
    });

    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await Promise.all([ticking, stopping]);
    expect(stopped).toBe(true);
  });
});
