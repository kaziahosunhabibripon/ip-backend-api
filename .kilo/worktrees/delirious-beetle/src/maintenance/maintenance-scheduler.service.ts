import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MaintenanceService, PruneReport } from './maintenance.service';

const EVERY_MS = 6 * 60 * 60_000;
/** Not at the very start: boot is busy enough, and a crash-looping instance should not hammer the database. */
const FIRST_RUN_MS = 60_000;

/**
 * Prunes old rows a few times a day from the API process. Deleting is idempotent, so instances that run it at the
 * same moment simply find nothing left. `MAINTENANCE_ENABLED=false` turns it off on instances that should only serve.
 */
@Injectable()
export class MaintenanceScheduler
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(MaintenanceScheduler.name);
  private readonly enabled: boolean;
  private first: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<PruneReport | null> | null = null;

  constructor(
    private readonly maintenance: MaintenanceService,
    config: ConfigService,
  ) {
    this.enabled = config.get<string>('MAINTENANCE_ENABLED') !== 'false';
  }

  onApplicationBootstrap() {
    if (!this.enabled) {
      this.logger.log(
        'Maintenance is off (MAINTENANCE_ENABLED=false); old rows will not be pruned on this instance.',
      );
      return;
    }
    this.first = setTimeout(() => void this.run(), FIRST_RUN_MS);
    this.first.unref();
    this.timer = setInterval(() => void this.run(), EVERY_MS);
    this.timer.unref();
    this.logger.log('Pruning old rows every 6 hours.');
  }

  async onApplicationShutdown() {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = this.timer = null;
    await this.current?.catch(() => undefined);
  }

  /** One pass; overlapping calls share the one in progress. A failure is logged and retried at the next interval. */
  run(now = new Date()): Promise<PruneReport | null> {
    this.current ??= this.maintenance
      .prune(now)
      .then((report) => {
        const removed = Object.entries(report).filter(([, n]) => n > 0);
        if (removed.length > 0) {
          this.logger.log(
            `Pruned ${removed.map(([name, n]) => `${n} ${name}`).join(', ')}.`,
          );
        }
        return report;
      })
      .catch((error: unknown) => {
        this.logger.error(
          `Pruning failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      })
      .finally(() => {
        this.current = null;
      });
    return this.current;
  }
}
