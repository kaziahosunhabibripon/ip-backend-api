import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import {
  and,
  desc,
  asc,
  eq,
  isNull,
  lt,
  or,
  sql,
  type InferSelectModel,
} from 'drizzle-orm';
import type { Database } from '../db/database';
import { apiKeys, users } from '../db/schema';
import type { UserRow } from '../users/user.mapper';
import type { ApiKeyEnvironment } from './api-key-secret';

export type ApiKeyRow = InferSelectModel<typeof apiKeys>;

export interface NewApiKey {
  name: string;
  environment: ApiKeyEnvironment;
  prefix: string;
  secretHash: string;
}

export type CreateKeyOutcome =
  { status: 'created'; key: ApiKeyRow } | { status: 'limit' };

/** Database access for API keys. The rules (naming, the cap, what a plan allows) live in `ApiKeysService`. */
@Injectable()
export class ApiKeysStore {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  list(userId: string): Promise<ApiKeyRow[]> {
    return this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.userId, userId))
      .orderBy(desc(apiKeys.createdAt), asc(apiKeys.id));
  }

  /** Counts and inserts under a per-user advisory lock, so simultaneous requests can't slip past the cap. */
  create(
    userId: string,
    input: NewApiKey,
    cap: number,
    now: Date,
  ): Promise<CreateKeyOutcome> {
    return this.db.transaction(async (tx): Promise<CreateKeyOutcome> => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`);

      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(apiKeys)
        .where(eq(apiKeys.userId, userId));
      if (count >= cap) {
        return { status: 'limit' };
      }

      const [key] = await tx
        .insert(apiKeys)
        .values({ userId, ...input, status: 'active', createdAt: now })
        .returning();
      return { status: 'created', key };
    });
  }

  /** Scoped to `userId`. Revoking twice is harmless and keeps the first revocation time. */
  async revoke(
    userId: string,
    id: string,
    now: Date,
  ): Promise<ApiKeyRow | undefined> {
    const [row] = await this.db
      .update(apiKeys)
      .set({
        status: 'revoked',
        revokedAt: sql`coalesce(${apiKeys.revokedAt}, ${now.toISOString()}::timestamp)`,
      })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)))
      .returning();
    return row;
  }

  /** For administrators: revokes any user's key by id. Same idempotence as `revoke`. */
  async revokeAny(id: string, now: Date): Promise<ApiKeyRow | undefined> {
    const [row] = await this.db
      .update(apiKeys)
      .set({
        status: 'revoked',
        revokedAt: sql`coalesce(${apiKeys.revokedAt}, ${now.toISOString()}::timestamp)`,
      })
      .where(eq(apiKeys.id, id))
      .returning();
    return row;
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const removed = await this.db
      .delete(apiKeys)
      .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)))
      .returning({ id: apiKeys.id });
    return removed.length > 0;
  }

  /** The key behind a secret's hash, with its owner — only while the key is still active. */
  async findActiveByHash(
    secretHash: string,
  ): Promise<{ key: ApiKeyRow; owner: UserRow } | undefined> {
    const [row] = await this.db
      .select({ key: apiKeys, owner: users })
      .from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.userId))
      .where(
        and(eq(apiKeys.secretHash, secretHash), eq(apiKeys.status, 'active')),
      )
      .limit(1);
    return row;
  }

  /** Rewrites `last_used_at` only when it is missing or older than `staleBefore`, so a busy key isn't a write per request. */
  async touch(id: string, now: Date, staleBefore: Date): Promise<void> {
    await this.db
      .update(apiKeys)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(apiKeys.id, id),
          or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, staleBefore)),
        ),
      );
  }
}
