import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { isPublicIp } from '../normalizer/ip-address';

const LIST_URL = 'https://check.torproject.org/torbulkexitlist';
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The Tor Project's public list of exit relays, refreshed every few hours. */
@Injectable()
export class TorExitListService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TorExitListService.name);
  private exits = new Set<string>();
  private timer?: NodeJS.Timeout;

  onModuleInit() {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  isExit(ip: string): boolean {
    return this.exits.has(ip.toLowerCase());
  }

  get size(): number {
    return this.exits.size;
  }

  async refresh(): Promise<void> {
    try {
      const response = await fetch(LIST_URL, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const addresses = (await response.text())
        .split('\n')
        .map((line) => line.trim().toLowerCase())
        .filter((line) => line && isPublicIp(line));
      if (addresses.length > 0) {
        this.exits = new Set(addresses);
        this.logger.log(`Loaded ${addresses.length} Tor exit addresses.`);
      }
    } catch (error) {
      // Keep whatever we had — an old list is far better than none.
      this.logger.warn(
        `Could not refresh the Tor exit list: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
