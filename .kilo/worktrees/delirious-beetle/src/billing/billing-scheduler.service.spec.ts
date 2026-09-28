import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { BillingJobs } from './billing-jobs.service';
import { BillingScheduler } from './billing-scheduler.service';

beforeAll(() => Logger.overrideLogger(false));

const NOW = new Date('2026-09-26T12:00:00.000Z');

const setup = (env: Record<string, string | undefined> = {}) => {
  const jobs = {
    pollDue: jest.fn(() => Promise.resolve(0)),
    rollExpired: jest.fn(() => Promise.resolve(0)),
    remind: jest.fn(() => Promise.resolve(0)),
  };
  const scheduler = new BillingScheduler(
    jobs as unknown as BillingJobs,
    { get: (key: string) => env[key] } as unknown as ConfigService,
  );
  return { scheduler, jobs };
};

describe('BillingScheduler.tick', () => {
  it('checks payments and ends paid periods every time', async () => {
    const { scheduler, jobs } = setup();

    await scheduler.tick(NOW);
    await scheduler.tick(new Date(NOW.getTime() + 20_000));

    expect(jobs.pollDue).toHaveBeenCalledTimes(2);
    expect(jobs.rollExpired).toHaveBeenCalledTimes(2);
  });

  it('sends reminders only every few minutes', async () => {
    const { scheduler, jobs } = setup();

    await scheduler.tick(NOW);
    await scheduler.tick(new Date(NOW.getTime() + 20_000));
    expect(jobs.remind).toHaveBeenCalledTimes(1);

    await scheduler.tick(new Date(NOW.getTime() + 5 * 60_000));
    expect(jobs.remind).toHaveBeenCalledTimes(2);
  });

  it('does not let one failing job stop the others', async () => {
    const { scheduler, jobs } = setup();
    jobs.pollDue.mockRejectedValueOnce(new Error('gateway down'));
    jobs.rollExpired.mockRejectedValueOnce(new Error('database blinked'));

    await expect(scheduler.tick(NOW)).resolves.toBeUndefined();

    expect(jobs.rollExpired).toHaveBeenCalled();
    expect(jobs.remind).toHaveBeenCalled();
  });

  it('collapses overlapping ticks into the one in progress', async () => {
    const { scheduler, jobs } = setup();
    let release: () => void = () => undefined;
    jobs.pollDue.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          release = () => resolve(0);
        }),
    );

    const first = scheduler.tick(NOW);
    const second = scheduler.tick(NOW);
    release();
    await Promise.all([first, second]);

    expect(jobs.pollDue).toHaveBeenCalledTimes(1);
  });
});

describe('BillingScheduler lifecycle', () => {
  it('does not schedule anything when switched off', () => {
    const { scheduler } = setup({ BILLING_SCHEDULER_ENABLED: 'false' });
    const timer = jest.spyOn(globalThis, 'setInterval');

    scheduler.onApplicationBootstrap();

    expect(timer).not.toHaveBeenCalled();
    timer.mockRestore();
  });

  it('schedules and stops cleanly when on', async () => {
    const { scheduler } = setup();

    scheduler.onApplicationBootstrap();
    await expect(scheduler.onApplicationShutdown()).resolves.toBeUndefined();
  });
});
