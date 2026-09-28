import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingJobs } from './billing-jobs.service';

const TICK_MS = 20_000;
/** Reminder and expiry emails look at a lot of rows for very little news, so they run every few minutes, not every tick. */
const REMIND_EVERY_MS = 5 * 60_000;

/**
 * Runs the billing jobs on a timer in the API process, like the monitoring scheduler: no queue, no extra service,
 * and every step takes its rows with `SKIP LOCKED`, so any number of instances can share a database. Switch it off
 * on instances that should only serve requests with `BILLING_SCHEDULER_ENABLED=false`, and keep it on for one.
 */
@Injectable()
export class BillingScheduler
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(BillingScheduler.name);
  private readonly enabled: boolean;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  private lastReminders = 0;

  constructor(
    private readonly jobs: BillingJobs,
    config: ConfigService,
  ) {
    this.enabled = config.get<string>('BILLING_SCHEDULER_ENABLED') !== 'false';
  }

  onApplicationBootstrap() {
    if (!this.enabled) {
      this.logger.log(
        'Billing scheduler is off (BILLING_SCHEDULER_ENABLED=false); payments will not be checked and plans will not end on this instance.',
      );
      return;
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    this.logger.log(`Billing scheduler running every ${TICK_MS / 1000}s.`);
  }

  async onApplicationShutdown() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.current?.catch(() => undefined);
  }

  /** One pass. Overlapping ticks collapse into the one in progress. */
  tick(now = new Date()): Promise<void> {
    this.current ??= this.pass(now).finally(() => {
      this.current = null;
    });
    return this.current;
  }

  private async pass(now: Date): Promise<void> {
    await this.guarded('checking payments', () => this.jobs.pollDue(now));
    await this.guarded('ending paid periods', () => this.jobs.rollExpired(now));

    if (now.getTime() - this.lastReminders >= REMIND_EVERY_MS) {
      this.lastReminders = now.getTime();
      await this.guarded('sending reminders', () => this.jobs.remind(now));
    }
  }

  /** One job failing (the database blinked, the gateway is down) must not stop the others or the next tick. */
  private async guarded(what: string, job: () => Promise<unknown>) {
    try {
      await job();
    } catch (error) {
      this.logger.error(
        `Billing job failed while ${what}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
