import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MonitorRunner } from './monitor-runner.service';
import { MonitorStore, type MonitorRow } from './monitor-store.service';

/** Monitors taken per tick; a backlog is worked off over the next ticks. */
const BATCH_SIZE = 25;
/** Runs in parallel within a batch — each makes a few outbound DNS and reputation calls. */
const CONCURRENCY = 5;
/**
 * How long a claimed monitor stays claimed if the instance dies mid-run. A run takes well under a
 * minute (provider timeouts plus the confirmation look), so this is generous.
 */
const LEASE_MS = 3 * 60_000;
const DEFAULT_TICK_SECONDS = 60;

const numberFrom = (raw: string | undefined, fallback: number) => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/**
 * Wakes up every tick, takes the monitors that are due and runs them. There is no separate queue to run:
 * the claim in `MonitorStore.claimDue` is atomic across instances, so running several API instances (or a
 * worker-only instance with `MONITORING_ENABLED` left on and the others switched off) never runs a monitor
 * twice. Each monitor's own interval lives on its row; the tick is just how often we look for due ones.
 */
@Injectable()
export class MonitorScheduler
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(MonitorScheduler.name);
  private readonly enabled: boolean;
  private readonly tickMs: number;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<number> | null = null;

  constructor(
    private readonly store: MonitorStore,
    private readonly runner: MonitorRunner,
    config: ConfigService,
  ) {
    this.enabled = config.get<string>('MONITORING_ENABLED') !== 'false';
    this.tickMs =
      numberFrom(
        config.get<string>('MONITORING_TICK_SECONDS'),
        DEFAULT_TICK_SECONDS,
      ) * 1000;
  }

  onApplicationBootstrap() {
    if (!this.enabled) {
      this.logger.log(
        'Monitoring scheduler is off (MONITORING_ENABLED=false); monitors will not run on this instance.',
      );
      return;
    }

    this.timer = setInterval(() => void this.tick(), this.tickMs);
    // Never keep the process alive just for the scheduler.
    this.timer.unref();
    this.logger.log(
      `Monitoring scheduler running every ${this.tickMs / 1000}s.`,
    );
  }

  /** Stops scheduling and lets the runs already in flight finish. */
  async onApplicationShutdown() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.current?.catch(() => undefined);
  }

  /** One pass. Returns how many monitors it ran. Overlapping ticks collapse into the one in progress. */
  tick(now = new Date()): Promise<number> {
    this.current ??= this.pass(now).finally(() => {
      this.current = null;
    });
    return this.current;
  }

  private async pass(now: Date): Promise<number> {
    let due: MonitorRow[];
    try {
      due = await this.store.claimDue(now, BATCH_SIZE, LEASE_MS);
    } catch (error) {
      this.logger.error(
        `Could not look for due monitors: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }

    for (let start = 0; start < due.length; start += CONCURRENCY) {
      await Promise.all(
        due.slice(start, start + CONCURRENCY).map((monitor) =>
          this.runner.run(monitor).catch((error: unknown) => {
            this.logger.error(
              `Monitor ${monitor.id} (${monitor.target}) failed to run: ${error instanceof Error ? error.message : String(error)}`,
            );
          }),
        ),
      );
    }
    return due.length;
  }
}
