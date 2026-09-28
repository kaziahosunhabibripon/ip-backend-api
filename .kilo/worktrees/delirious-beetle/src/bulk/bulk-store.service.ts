import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from 'drizzle-orm';
import type {
  BulkItemError,
  BulkItemStatus,
  BulkItemSummary,
  BulkStopReason,
} from '../contracts';
import type { Database } from '../db/database';
import { bulkItems, bulkJobs, users } from '../db/schema';
import type { ItemRow, JobRow, PreparedItem } from './bulk-rules';

/** Rows per INSERT: 8 columns each, far below Postgres' parameter limit. */
const INSERT_CHUNK = 1_000;

export type StoredJob = JobRow & { userId: string };
export type ByStatus = Partial<Record<BulkItemStatus, number>>;

export interface ItemOutcome {
  status: Exclude<BulkItemStatus, 'pending' | 'skipped'>;
  summary?: BulkItemSummary | null;
  error?: BulkItemError | null;
}

export interface PendingItem {
  position: number;
  input: string;
  target: string;
  type: NonNullable<ItemRow['type']>;
}

@Injectable()
export class BulkStore {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /**
   * Creates the job and all its lines in one transaction, so a worker never sees half a batch. A batch with
   * nothing to look up (every line invalid) is born completed.
   */
  createJob(
    userId: string,
    input: { name: string | null; duplicates: number; items: PreparedItem[] },
    now = new Date(),
  ): Promise<StoredJob> {
    return this.db.transaction(async (tx) => {
      const hasWork = input.items.some((item) => item.status === 'pending');
      const [job] = await tx
        .insert(bulkJobs)
        .values({
          userId,
          name: input.name,
          duplicates: input.duplicates,
          status: hasWork ? 'queued' : 'completed',
          startedAt: hasWork ? null : now,
          finishedAt: hasWork ? null : now,
        })
        .returning();

      for (let start = 0; start < input.items.length; start += INSERT_CHUNK) {
        await tx.insert(bulkItems).values(
          input.items.slice(start, start + INSERT_CHUNK).map((item) => ({
            jobId: job.id,
            position: item.position,
            input: item.input,
            target: item.target,
            type: item.type,
            status: item.status,
            error: item.error,
          })),
        );
      }
      return job;
    });
  }

  countOpen(userId: string): Promise<number> {
    return this.db
      .select({ n: count() })
      .from(bulkJobs)
      .where(
        and(
          eq(bulkJobs.userId, userId),
          inArray(bulkJobs.status, ['queued', 'running']),
        ),
      )
      .then(([row]) => row.n);
  }

  listJobs(userId: string, limit: number): Promise<StoredJob[]> {
    return this.db
      .select()
      .from(bulkJobs)
      .where(eq(bulkJobs.userId, userId))
      .orderBy(desc(bulkJobs.createdAt), desc(bulkJobs.id))
      .limit(limit);
  }

  async findJob(userId: string, id: string): Promise<StoredJob | null> {
    const [row] = await this.db
      .select()
      .from(bulkJobs)
      .where(and(eq(bulkJobs.id, id), eq(bulkJobs.userId, userId)));
    return row ?? null;
  }

  /** Row counts per status for each of the jobs, in one query. */
  async countsByStatus(jobIds: string[]): Promise<Map<string, ByStatus>> {
    const result = new Map<string, ByStatus>(jobIds.map((id) => [id, {}]));
    if (jobIds.length === 0) {
      return result;
    }
    const rows = await this.db
      .select({
        jobId: bulkItems.jobId,
        status: bulkItems.status,
        n: count(),
      })
      .from(bulkItems)
      .where(inArray(bulkItems.jobId, jobIds))
      .groupBy(bulkItems.jobId, bulkItems.status);
    for (const row of rows) {
      result.get(row.jobId)![row.status] = row.n;
    }
    return result;
  }

  pageItems(jobId: string, offset: number, limit: number): Promise<ItemRow[]> {
    return this.db
      .select({
        position: bulkItems.position,
        input: bulkItems.input,
        target: bulkItems.target,
        type: bulkItems.type,
        status: bulkItems.status,
        summary: bulkItems.summary,
        error: bulkItems.error,
      })
      .from(bulkItems)
      .where(eq(bulkItems.jobId, jobId))
      .orderBy(asc(bulkItems.position))
      .offset(offset)
      .limit(limit);
  }

  /** Deleting a job that is running cancels it: the worker's next lease renewal finds nothing and stops. */
  async deleteJob(userId: string, id: string): Promise<boolean> {
    const removed = await this.db
      .delete(bulkJobs)
      .where(and(eq(bulkJobs.id, id), eq(bulkJobs.userId, userId)))
      .returning({ id: bulkJobs.id });
    return removed.length > 0;
  }

  /**
   * Takes the job that has waited longest since a worker last touched it, and holds it for `leaseMs`. Atomic
   * across instances (`SKIP LOCKED`). A job whose owner is suspended is left alone until they are reactivated.
   * If the worker dies the lease simply runs out and another instance resumes the job from its pending lines.
   */
  claimJob(now: Date, leaseMs: number): Promise<StoredJob | null> {
    return this.db.transaction(async (tx) => {
      const [found] = await tx
        .select({ job: bulkJobs })
        .from(bulkJobs)
        .innerJoin(users, eq(users.id, bulkJobs.userId))
        .where(
          and(
            inArray(bulkJobs.status, ['queued', 'running']),
            or(isNull(bulkJobs.leasedUntil), lt(bulkJobs.leasedUntil, now)),
            isNull(users.suspendedAt),
          ),
        )
        .orderBy(
          sql`coalesce(${bulkJobs.lastRunAt}, ${bulkJobs.createdAt})`,
          asc(bulkJobs.id),
        )
        .limit(1)
        .for('update', { of: bulkJobs, skipLocked: true });

      if (!found) {
        return null;
      }

      const [claimed] = await tx
        .update(bulkJobs)
        .set({
          status: 'running',
          leasedUntil: new Date(now.getTime() + leaseMs),
          lastRunAt: now,
          startedAt: found.job.startedAt ?? now,
        })
        .where(eq(bulkJobs.id, found.job.id))
        .returning();
      return claimed;
    });
  }

  /** False when the job was deleted (cancelled) in the meantime. */
  async renewLease(jobId: string, until: Date): Promise<boolean> {
    const renewed = await this.db
      .update(bulkJobs)
      .set({ leasedUntil: until })
      .where(and(eq(bulkJobs.id, jobId), eq(bulkJobs.status, 'running')))
      .returning({ id: bulkJobs.id });
    return renewed.length > 0;
  }

  async releaseLease(jobId: string, now: Date): Promise<void> {
    await this.db
      .update(bulkJobs)
      .set({ leasedUntil: null, lastRunAt: now })
      .where(and(eq(bulkJobs.id, jobId), eq(bulkJobs.status, 'running')));
  }

  async pending(jobId: string, limit: number): Promise<PendingItem[]> {
    const rows = await this.db
      .select({
        position: bulkItems.position,
        input: bulkItems.input,
        target: bulkItems.target,
        type: bulkItems.type,
      })
      .from(bulkItems)
      .where(and(eq(bulkItems.jobId, jobId), eq(bulkItems.status, 'pending')))
      .orderBy(asc(bulkItems.position))
      .limit(limit);
    // Only lines that were queued have a target; invalid ones are never pending.
    return rows.filter(
      (row): row is PendingItem => row.target !== null && row.type !== null,
    );
  }

  /** Only a line that is still pending is written, so a repeat (after a lease ran out mid-run) changes nothing. */
  async recordItem(
    jobId: string,
    position: number,
    outcome: ItemOutcome,
  ): Promise<void> {
    await this.db
      .update(bulkItems)
      .set({
        status: outcome.status,
        summary: outcome.summary ?? null,
        error: outcome.error ?? null,
      })
      .where(
        and(
          eq(bulkItems.jobId, jobId),
          eq(bulkItems.position, position),
          eq(bulkItems.status, 'pending'),
        ),
      );
  }

  /** Marks every line still pending as skipped, with the reason. Returns how many. */
  async skipRemaining(jobId: string, error: BulkItemError): Promise<number> {
    const skipped = await this.db
      .update(bulkItems)
      .set({ status: 'skipped', error })
      .where(and(eq(bulkItems.jobId, jobId), eq(bulkItems.status, 'pending')))
      .returning({ position: bulkItems.position });
    return skipped.length;
  }

  async finish(
    jobId: string,
    reason: BulkStopReason | null,
    now: Date,
  ): Promise<void> {
    await this.db
      .update(bulkJobs)
      .set({
        status: 'completed',
        stoppedReason: reason,
        finishedAt: now,
        leasedUntil: null,
      })
      .where(eq(bulkJobs.id, jobId));
  }
}
