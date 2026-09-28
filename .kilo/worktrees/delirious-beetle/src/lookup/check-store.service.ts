import { createId } from '@paralleldrive/cuid2';
import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, desc, eq, gte } from 'drizzle-orm';
import type { DomainCheckResult } from '../contracts';
import type { Database } from '../db/database';
import { historyItems } from '../db/schema';

/** Saved checks. Listing, searching and deleting them is the history feature (Phase 3); this is the write path plus "reopen one". */
@Injectable()
export class CheckStore {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** `checkedAt` is when the user ran the check; the report inside keeps its own (possibly older) data time. */
  async save(
    userId: string,
    result: DomainCheckResult,
    checkedAt = new Date(result.checkedAt),
  ): Promise<void> {
    await this.db.insert(historyItems).values({
      id: result.id,
      userId,
      target: result.target,
      type: result.type,
      status: result.status,
      ipCount: result.ips.length,
      checkedAt,
      result,
    });
  }

  /**
   * Files a report that was served from the cache and returns the id of the viewer's own row for it.
   * The cache is shared by everyone, so the report's own id belongs to whoever ran it first: this saves a
   * copy under a new id. A user who already has this report (same target, at least as new) isn't given a
   * second row for every repeat within the cache window; their existing row's id is returned instead.
   */
  async saveFromCache(
    userId: string,
    result: DomainCheckResult,
  ): Promise<string> {
    const [existing] = await this.db
      .select({ id: historyItems.id })
      .from(historyItems)
      .where(
        and(
          eq(historyItems.userId, userId),
          eq(historyItems.target, result.target),
          gte(historyItems.checkedAt, new Date(result.checkedAt)),
        ),
      )
      .orderBy(desc(historyItems.checkedAt), asc(historyItems.id))
      .limit(1);

    if (existing) {
      return existing.id;
    }

    const id = `chk_${createId()}`;
    await this.save(userId, { ...result, id }, new Date());
    return id;
  }

  /** Scoped to `userId`: another user's check id looks exactly like a missing one. */
  async find(userId: string, id: string): Promise<DomainCheckResult | null> {
    const [row] = await this.db
      .select({ result: historyItems.result })
      .from(historyItems)
      .where(and(eq(historyItems.id, id), eq(historyItems.userId, userId)))
      .limit(1);

    return row?.result ?? null;
  }
}
