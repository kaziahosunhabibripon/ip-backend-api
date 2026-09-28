import { Injectable } from '@nestjs/common';
import type { ProviderKey } from '../../contracts';

/** How far back "recent" reaches. */
export const HEALTH_WINDOW_MS = 15 * 60_000;
/** Enough to describe a busy provider without growing without bound. */
const MAX_SAMPLES = 2000;

interface Sample {
  at: number;
  ok: boolean;
  latencyMs: number;
}

export interface ProviderStats {
  /** Fresh provider calls in the window; cache hits never reach a provider and aren't counted. */
  calls: number;
  errors: number;
  /** 0–1; 0 when there were no calls. */
  errorRate: number;
  /** Average time of the calls that answered; 0 when none did. */
  latencyMs: number;
}

/**
 * What the last fifteen minutes of real provider calls looked like, for the admin view. It lives in this
 * process's memory: with several API instances each shows its own traffic, which is the honest reading of
 * "how is this provider doing for me right now" and costs nothing per lookup.
 */
@Injectable()
export class ProviderHealthService {
  private readonly samples = new Map<ProviderKey, Sample[]>();

  record(
    provider: ProviderKey,
    ok: boolean,
    latencyMs: number,
    now = Date.now(),
  ): void {
    const list = this.samples.get(provider) ?? [];
    list.push({ at: now, ok, latencyMs });
    this.prune(list, now);
    this.samples.set(provider, list);
  }

  statsFor(provider: ProviderKey, now = Date.now()): ProviderStats {
    const list = this.samples.get(provider) ?? [];
    this.prune(list, now);

    const errors = list.filter((sample) => !sample.ok).length;
    const answered = list.filter((sample) => sample.ok);
    return {
      calls: list.length,
      errors,
      errorRate: list.length === 0 ? 0 : errors / list.length,
      latencyMs:
        answered.length === 0
          ? 0
          : Math.round(
              answered.reduce((sum, sample) => sum + sample.latencyMs, 0) /
                answered.length,
            ),
    };
  }

  /** Drops what has aged out of the window, and the oldest beyond the cap. In place: the caller holds the array. */
  private prune(list: Sample[], now: number) {
    const cutoff = now - HEALTH_WINDOW_MS;
    let stale = 0;
    while (stale < list.length && list[stale].at < cutoff) {
      stale += 1;
    }
    const excess = Math.max(0, list.length - stale - MAX_SAMPLES);
    if (stale + excess > 0) {
      list.splice(0, stale + excess);
    }
  }
}
