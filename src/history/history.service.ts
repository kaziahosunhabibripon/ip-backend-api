import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, desc, eq, gte, ilike, ne, sql, type SQL } from 'drizzle-orm';
import { ApiException } from '../common/dto/api-exception';
import type {
  CheckHistory,
  HistoryQuery,
  HistoryRangeFilter,
  HistorySort,
  HistoryStatus,
  InputType,
  Paginated,
} from '../contracts';
import type { Database } from '../db/database';
import { historyItems } from '../db/schema';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 10;

const columns = {
  id: historyItems.id,
  target: historyItems.target,
  type: historyItems.type,
  ipCount: historyItems.ipCount,
  status: historyItems.status,
  checkedAt: historyItems.checkedAt,
};

/** Every order ends on `id`, so paging through equal rows never repeats or skips one. */
const ORDER: Record<HistorySort, SQL[]> = {
  newest: [desc(historyItems.checkedAt), asc(historyItems.id)],
  oldest: [asc(historyItems.checkedAt), asc(historyItems.id)],
  target: [
    asc(historyItems.target),
    desc(historyItems.checkedAt),
    asc(historyItems.id),
  ],
  ips: [
    desc(historyItems.ipCount),
    desc(historyItems.checkedAt),
    asc(historyItems.id),
  ],
};

/** `%` and `_` are wildcards in LIKE; a search for "a_b" should find "a_b", not "axb". */
const escapeLike = (text: string) => text.replace(/[\\%_]/g, '\\$&');

const since = (range: HistoryRangeFilter, now: Date): Date | null => {
  if (range === 'today') {
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
  }
  if (range === '7d') {
    return new Date(now.getTime() - 7 * DAY_MS);
  }
  if (range === '30d') {
    return new Date(now.getTime() - 30 * DAY_MS);
  }
  return null;
};

type Row = {
  [K in keyof typeof columns]: (typeof historyItems.$inferSelect)[K];
};

// `type` and `status` are only ever written by our own lookup code, so the wider column type is safe to narrow.
export const toCheckHistory = (row: Row): CheckHistory => ({
  id: row.id,
  target: row.target,
  type: row.type as InputType,
  ipCount: row.ipCount,
  status: row.status as HistoryStatus,
  checkedAt: row.checkedAt.toISOString(),
});

@Injectable()
export class HistoryService {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  async list(
    userId: string,
    query: HistoryQuery,
    now = new Date(),
  ): Promise<Paginated<CheckHistory>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const conditions: (SQL | undefined)[] = [eq(historyItems.userId, userId)];
    const needle = query.q?.trim();
    if (needle) {
      conditions.push(ilike(historyItems.target, `%${escapeLike(needle)}%`));
    }
    if (query.type === 'domain') {
      conditions.push(eq(historyItems.type, 'domain'));
    } else if (query.type === 'ip') {
      conditions.push(ne(historyItems.type, 'domain'));
    }
    const from = since(query.range ?? 'any', now);
    if (from) {
      conditions.push(gte(historyItems.checkedAt, from));
    }
    const where = and(...conditions);

    const [rows, counted] = await Promise.all([
      this.db
        .select(columns)
        .from(historyItems)
        .where(where)
        .orderBy(...ORDER[query.sort ?? 'newest'])
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(historyItems)
        .where(where),
    ]);

    return {
      items: rows.map(toCheckHistory),
      total: counted[0]?.count ?? 0,
      page,
      pageSize,
    };
  }

  async recent(userId: string, limit: number): Promise<CheckHistory[]> {
    const rows = await this.db
      .select(columns)
      .from(historyItems)
      .where(eq(historyItems.userId, userId))
      .orderBy(...ORDER.newest)
      .limit(limit);
    return rows.map(toCheckHistory);
  }

  /** Scoped to `userId`: someone else's id is indistinguishable from a missing one. */
  async remove(userId: string, id: string): Promise<void> {
    const removed = await this.db
      .delete(historyItems)
      .where(and(eq(historyItems.id, id), eq(historyItems.userId, userId)))
      .returning({ id: historyItems.id });

    if (removed.length === 0) {
      throw new ApiException('NOT_FOUND', 'That check was not found.');
    }
  }

  async clear(userId: string): Promise<void> {
    await this.db.delete(historyItems).where(eq(historyItems.userId, userId));
  }
}
