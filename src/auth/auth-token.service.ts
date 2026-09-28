import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, gt } from 'drizzle-orm';
import { generateToken, hashToken } from '../common/crypto';
import type { Database } from '../db/database';
import { authTokens } from '../db/schema';

export type AuthTokenType = (typeof authTokens.$inferSelect)['type'];

export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

@Injectable()
export class AuthTokenService {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** Creates a fresh single-use token; any earlier outstanding token of the same type for this user stops working. */
  async issue(
    userId: string,
    type: AuthTokenType,
    ttlMs: number,
  ): Promise<string> {
    const token = generateToken();

    await this.db.transaction(async (tx) => {
      await tx
        .delete(authTokens)
        .where(and(eq(authTokens.userId, userId), eq(authTokens.type, type)));
      await tx.insert(authTokens).values({
        userId,
        type,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + ttlMs),
      });
    });

    return token;
  }

  /**
   * Looks up the token's owner without spending it. For a flow that checks the owner against someone already
   * signed in (team invites) before deciding whether to consume it at all — consuming first would let a wrong
   * guess (or the wrong signed-in account) burn someone else's one-use link just by trying it.
   */
  async verify(token: string, type: AuthTokenType): Promise<string | null> {
    const [row] = await this.db
      .select({ userId: authTokens.userId })
      .from(authTokens)
      .where(
        and(
          eq(authTokens.tokenHash, hashToken(token)),
          eq(authTokens.type, type),
          gt(authTokens.expiresAt, new Date()),
        ),
      );
    return row?.userId ?? null;
  }

  /** Atomically deletes the token and returns its owner, so a link works exactly once. Null if unknown, used or expired. */
  async consume(token: string, type: AuthTokenType): Promise<string | null> {
    const [row] = await this.db
      .delete(authTokens)
      .where(
        and(
          eq(authTokens.tokenHash, hashToken(token)),
          eq(authTokens.type, type),
          gt(authTokens.expiresAt, new Date()),
        ),
      )
      .returning({ userId: authTokens.userId });

    return row?.userId ?? null;
  }
}
