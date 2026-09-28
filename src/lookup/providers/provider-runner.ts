import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheService } from '../../cache/cache.service';
import type { ProviderKey, SectionResult } from '../../contracts';
import { ProviderHealthService } from './provider-health.service';
import {
  ProviderTimeoutError,
  ProviderUnavailableError,
  withTimeout,
} from './provider.types';

export interface RunSpec<T> {
  provider: ProviderKey;
  /** `lookup:{provider}:{target}` — omit for sources that are already local and instant. */
  cacheKey?: string;
  ttlSeconds?: number;
  timeoutMs: number;
  bypassCache?: boolean;
  work: (signal: AbortSignal) => Promise<T>;
}

export interface Outcome<T> {
  section: SectionResult<T>;
  latencyMs: number;
  /** Set when the answer came from the cache. */
  cachedAgeSeconds?: number;
}

/**
 * Runs one provider call the way §4.3 of the plan requires: its own timeout, its own cache key,
 * and a failure that becomes a `SectionResult` instead of an exception — so a slow or broken
 * provider degrades its own section and never the whole lookup.
 */
@Injectable()
export class ProviderRunner {
  private readonly logger = new Logger(ProviderRunner.name);
  private readonly forcedFailures: ReadonlySet<string>;

  constructor(
    private readonly cache: CacheService,
    config: ConfigService,
    private readonly health: ProviderHealthService,
  ) {
    // Staging switch for the Phase 2 exit test: LOOKUP_FORCE_FAIL=security makes that provider fail on demand.
    this.forcedFailures = new Set(
      (config.get<string>('LOOKUP_FORCE_FAIL') ?? '')
        .split(',')
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean),
    );
  }

  async run<T>(spec: RunSpec<T>): Promise<Outcome<T>> {
    const started = Date.now();

    if (this.forcedFailures.has(spec.provider)) {
      return {
        section: {
          status: 'unavailable',
          message: `The ${spec.provider} provider was forced to fail (LOOKUP_FORCE_FAIL).`,
        },
        latencyMs: 0,
      };
    }

    const cacheable = Boolean(spec.cacheKey && spec.ttlSeconds);
    if (cacheable && !spec.bypassCache) {
      const hit = await this.cache.get<T>(spec.cacheKey!);
      if (hit) {
        return {
          section: { status: 'ok', data: hit.value },
          latencyMs: Date.now() - started,
          cachedAgeSeconds: hit.ageSeconds,
        };
      }
    }

    try {
      const data = await withTimeout(spec.work, spec.timeoutMs);
      if (cacheable) {
        await this.cache.set(spec.cacheKey!, data, spec.ttlSeconds!);
      }
      const latencyMs = Date.now() - started;
      this.health.record(spec.provider, true, latencyMs);
      return { section: { status: 'ok', data }, latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - started;
      this.health.record(spec.provider, false, latencyMs);
      return { section: this.toFailure(spec.provider, error), latencyMs };
    }
  }

  private toFailure(
    provider: ProviderKey,
    error: unknown,
  ): SectionResult<never> {
    if (error instanceof ProviderTimeoutError) {
      return { status: 'timeout', message: error.message };
    }
    if (error instanceof ProviderUnavailableError) {
      return { status: 'unavailable', message: error.message };
    }

    // Anything else is a bug or an unexpected upstream failure: log the detail, show something safe.
    this.logger.error(
      `${provider} provider failed unexpectedly: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    return { status: 'unavailable', message: 'Temporarily unavailable.' };
  }
}
