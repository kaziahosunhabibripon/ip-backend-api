import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BulkRunner, LEASE_MS } from './bulk-runner.service';
import { BulkStore } from './bulk-store.service';

const TICK_MS = 3_000;
/**
 * How long one job keeps a worker before the next waiting job gets a turn. With nothing else waiting the same job
 * is simply taken again, so this only matters when several people have batches queued.
 */
export const SLICE_MS = 20_000;

/**
 * Runs bulk jobs in the API process, like the monitoring and billing schedulers: no queue, no extra service. A job
 * is taken under a lease in the database, so any number of instances can share the work and a crashed instance's
 * job is picked up again where it stopped. Switch it off on instances that should only serve requests with
 * `BULK_SCHEDULER_ENABLED=false`, and keep it on for at least one.
 */
@Injectable()
export class BulkScheduler
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(BulkScheduler.name);
  private readonly enabled: boolean;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<number> | null = null;
  private stopping = false;

  constructor(
    private readonly store: BulkStore,
    private readonly runner: BulkRunner,
    config: ConfigService,
  ) {
    this.enabled = config.get<string>('BULK_SCHEDULER_ENABLED') !== 'false';
  }

  onApplicationBootstrap() {
    if (!this.enabled) {
      this.logger.log(
        'Bulk scheduler is off (BULK_SCHEDULER_ENABLED=false); batches will not be worked on by this instance.',
      );
      return;
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    this.logger.log(`Bulk scheduler running every ${TICK_MS / 1000}s.`);
  }

  async onApplicationShutdown() {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.current?.catch(() => undefined);
  }

  /** One pass. Returns how many job slices it worked. Overlapping ticks collapse into the one in progress. */
  tick(): Promise<number> {
    this.current ??= this.pass().finally(() => {
      this.current = null;
    });
    return this.current;
  }

  private async pass(): Promise<number> {
    let slices = 0;
    while (!this.stopping) {
      try {
        const job = await this.store.claimJob(new Date(), LEASE_MS);
        if (!job) {
          break;
        }
        slices += 1;
        await this.runner.run(job, Date.now() + SLICE_MS, () => this.stopping);
      } catch (error) {
        // The database blinked or a run blew up: wait for the next tick instead of retrying in a hot loop.
        this.logger.error(
          `Bulk pass failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        break;
      }
    }
    return slices;
  }
}
