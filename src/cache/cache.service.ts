import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

interface Entry {
  value: string;
  expiresAt: number;
}

const MEMORY_LIMIT = 5000;
const ERROR_LOG_INTERVAL_MS = 60_000;

/**
 * JSON key-value cache with a TTL. Redis when it's configured and reachable; otherwise an
 * in-process map, so lookups still work (just without sharing across instances or restarts)
 * when Redis is down — a cache outage must never turn into a lookup outage.
 */
@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly redis: Redis | null;
  private readonly memory = new Map<string, Entry>();
  private lastErrorLoggedAt = 0;

  constructor(config: ConfigService) {
    const url = config.get<string>('REDIS_URL')?.trim();
    const host = config.get<string>('REDIS_HOST')?.trim();

    if (!url && !host) {
      this.redis = null;
      this.logger.warn(
        'REDIS_HOST is not set — using an in-memory cache (not shared between instances).',
      );
      return;
    }

    const options = {
      lazyConnect: true,
      // Fail a command immediately when Redis is down instead of queueing it behind a dead socket.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1500,
      commandTimeout: 500,
      retryStrategy: (attempt: number) => Math.min(attempt * 1000, 15_000),
    };
    this.redis = url
      ? new Redis(url, options)
      : new Redis({
          ...options,
          host,
          port: Number(config.get<string>('REDIS_PORT') ?? 6379),
          password: config.get<string>('REDIS_PASSWORD') || undefined,
        });

    this.redis.on('error', (error: Error) => this.logRedisProblem(error));
    this.redis.on('ready', () => this.logger.log('Redis cache connected.'));
  }

  /** `redis`: shared and healthy; `redis-down`: configured but unreachable, so this instance is on its in-process fallback; `memory`: no Redis configured. */
  get mode(): 'redis' | 'redis-down' | 'memory' {
    if (!this.redis) {
      return 'memory';
    }
    return this.redis.status === 'ready' ? 'redis' : 'redis-down';
  }

  onModuleInit() {
    // Don't hold up startup on Redis; the client keeps retrying in the background.
    this.redis?.connect().catch(() => undefined);
  }

  async onModuleDestroy() {
    if (!this.redis) {
      return;
    }
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }

  async get<T>(key: string): Promise<{ value: T; ageSeconds: number } | null> {
    const raw = await this.read(key);
    if (raw === null) {
      return null;
    }

    try {
      const stored = JSON.parse(raw) as { v: T; at: number };
      return {
        value: stored.v,
        ageSeconds: Math.max(0, Math.round((Date.now() - stored.at) / 1000)),
      };
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const raw = JSON.stringify({ v: value, at: Date.now() });

    if (this.redis?.status === 'ready') {
      try {
        await this.redis.set(key, raw, 'EX', ttlSeconds);
        return;
      } catch (error) {
        this.logRedisProblem(error);
      }
    }

    this.memorySet(key, raw, ttlSeconds);
  }

  /**
   * Counts one hit in a fixed window (the current `windowSeconds`-long slice of the clock) and returns
   * the running count with the seconds until the window rolls over. The window number is part of the key,
   * so nothing has to be reset and an `EXPIRE` that never arrives can't leave a counter stuck: a stale
   * key is simply never read again. Shared across instances through Redis; with Redis down each instance
   * counts on its own, which loosens a limit rather than blocking anyone.
   */
  async increment(
    key: string,
    windowSeconds: number,
  ): Promise<{ count: number; resetsInSeconds: number }> {
    const windowMs = windowSeconds * 1000;
    const now = Date.now();
    const window = Math.floor(now / windowMs);
    const resetsInSeconds = Math.max(
      1,
      Math.ceil(((window + 1) * windowMs - now) / 1000),
    );
    const windowKey = `${key}:${window}`;

    if (this.redis?.status === 'ready') {
      try {
        const results = await this.redis
          .multi()
          .incr(windowKey)
          .expire(windowKey, windowSeconds * 2)
          .exec();
        const count = Number(results?.[0]?.[1]);
        if (Number.isFinite(count)) {
          return { count, resetsInSeconds };
        }
      } catch (error) {
        this.logRedisProblem(error);
      }
    }

    const entry = this.memory.get(windowKey);
    const current =
      entry && entry.expiresAt > Date.now() ? Number(entry.value) : 0;
    this.memorySet(windowKey, String(current + 1), windowSeconds * 2);
    return { count: current + 1, resetsInSeconds };
  }

  private async read(key: string): Promise<string | null> {
    if (this.redis?.status === 'ready') {
      try {
        return await this.redis.get(key);
      } catch (error) {
        this.logRedisProblem(error);
      }
    }

    const entry = this.memory.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.memory.delete(key);
      return null;
    }
    return entry.value;
  }

  private memorySet(key: string, value: string, ttlSeconds: number) {
    if (this.memory.size >= MEMORY_LIMIT) {
      // Maps iterate in insertion order, so the first keys are the oldest.
      const oldest = [...this.memory.keys()].slice(0, MEMORY_LIMIT / 10);
      oldest.forEach((oldKey) => this.memory.delete(oldKey));
    }
    this.memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  private logRedisProblem(error: unknown) {
    const now = Date.now();
    if (now - this.lastErrorLoggedAt < ERROR_LOG_INTERVAL_MS) {
      return;
    }
    this.lastErrorLoggedAt = now;
    this.logger.warn(
      `Redis unavailable, serving from the in-memory cache instead: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
