import type { ConfigService } from '@nestjs/config';
import { MaintenanceScheduler } from './maintenance-scheduler.service';
import type { MaintenanceService, PruneReport } from './maintenance.service';

const empty: PruneReport = {
  sessions: 0,
  authTokens: 0,
  lookupEvents: 0,
  anonymousCounters: 0,
  monthlyCounters: 0,
  alerts: 0,
  bulkJobs: 0,
};

const build = (prune: jest.Mock, env: Record<string, string> = {}) => {
  const config = { get: (k: string) => env[k] } as unknown as ConfigService;
  return new MaintenanceScheduler(
    { prune } as unknown as MaintenanceService,
    config,
  );
};

describe('MaintenanceScheduler', () => {
  it('returns the report of a pass', async () => {
    const prune = jest.fn().mockResolvedValue({ ...empty, sessions: 2 });
    await expect(build(prune).run()).resolves.toMatchObject({ sessions: 2 });
  });

  it('turns a failure into null instead of throwing, and can run again after', async () => {
    const prune = jest
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(empty);
    const scheduler = build(prune);
    await expect(scheduler.run()).resolves.toBeNull();
    await expect(scheduler.run()).resolves.toEqual(empty);
  });

  it('collapses overlapping calls into one pass', async () => {
    let release: (report: PruneReport) => void = () => undefined;
    const prune = jest.fn(
      () => new Promise<PruneReport>((resolve) => (release = resolve)),
    );
    const scheduler = build(prune);
    const a = scheduler.run();
    const b = scheduler.run();
    release(empty);
    await Promise.all([a, b]);
    expect(prune).toHaveBeenCalledTimes(1);
  });

  it('schedules nothing when MAINTENANCE_ENABLED=false', () => {
    jest.useFakeTimers();
    try {
      const prune = jest.fn().mockResolvedValue(empty);
      build(prune, { MAINTENANCE_ENABLED: 'false' }).onApplicationBootstrap();
      jest.advanceTimersByTime(7 * 60 * 60_000);
      expect(prune).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('runs once after the first minute, then again every six hours', async () => {
    jest.useFakeTimers();
    try {
      const prune = jest.fn().mockResolvedValue(empty);
      const scheduler = build(prune);
      scheduler.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(59_000);
      expect(prune).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(2_000);
      expect(prune).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(6 * 60 * 60_000);
      expect(prune).toHaveBeenCalledTimes(2);
      await scheduler.onApplicationShutdown();
    } finally {
      jest.useRealTimers();
    }
  });
});
