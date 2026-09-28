import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from '../cache/cache.service';
import {
  ABUSE_RULES,
  shouldRecord,
  type AbuseKind,
  type AbuseReason,
} from './abuse-rules';
import { AbuseStore } from './abuse-store.service';

/** How long "is this network blocked?" may be remembered in-process, so anonymous lookups don't each cost a query. */
const BLOCK_CACHE_MS = 15_000;

/**
 * The two things the rest of the app asks of abuse handling: "note that this happened" and "is this network
 * blocked?". Noting is cheap and can never break the request that triggered it — counts live in the shared
 * cache, and a database write happens only when a count passes a bar (see `abuse-rules.ts`). Deciding what to do
 * about a flag is the administrator's job and lives in the admin module.
 */
@Injectable()
export class AbuseService {
  private readonly logger = new Logger(AbuseService.name);
  private readonly blocked = new Map<
    string,
    { blocked: boolean; until: number }
  >();

  constructor(
    private readonly cache: CacheService,
    private readonly store: AbuseStore,
  ) {}

  /**
   * Counts one occurrence of `reason` for a subject. Never throws and never waits on the database for the
   * common case (a count under the bar): callers can `void` it.
   */
  async note(
    kind: AbuseKind,
    subjectKey: string,
    reason: AbuseReason,
  ): Promise<void> {
    try {
      const rule = ABUSE_RULES[reason];
      const { count } = await this.cache.increment(
        `abuse:${reason}:${kind}:${subjectKey}`,
        rule.windowSeconds,
      );
      if (shouldRecord(reason, count)) {
        await this.store.raise({ kind, subjectKey, reason, events: count });
      }
    } catch (error) {
      this.logger.warn(
        `Could not note ${reason} for ${kind} ${subjectKey}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** True when administrators have blocked this (hashed) network from anonymous lookups. A lookup failure means "not blocked": this must never take lookups down. */
  async isBlocked(visitorHash: string, now = Date.now()): Promise<boolean> {
    const remembered = this.blocked.get(visitorHash);
    if (remembered && remembered.until > now) {
      return remembered.blocked;
    }

    try {
      const blocked = await this.store.isBlocked(visitorHash);
      this.remember(visitorHash, blocked, now);
      return blocked;
    } catch (error) {
      this.logger.warn(
        `Could not check the network blocklist: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  async blockVisitor(
    visitorHash: string,
    reason: string,
    blockedBy: string,
  ): Promise<void> {
    await this.store.block(visitorHash, reason, blockedBy);
    this.remember(visitorHash, true, Date.now());
  }

  async unblockVisitor(visitorHash: string): Promise<void> {
    await this.store.unblock(visitorHash);
    this.remember(visitorHash, false, Date.now());
  }

  private remember(visitorHash: string, blocked: boolean, now: number) {
    if (this.blocked.size > 5000) {
      this.blocked.clear();
    }
    this.blocked.set(visitorHash, { blocked, until: now + BLOCK_CACHE_MS });
  }
}
