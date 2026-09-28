import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, desc, eq, gt, isNull, lt, ne } from 'drizzle-orm';
import { generateToken, hashToken } from '../common/crypto';
import type { SessionInfo, User } from '../contracts';
import type { Database } from '../db/database';
import { sessions, users } from '../db/schema';
import { GeoProvider } from '../lookup/providers/geo.provider';
import { toUser } from '../users/user.mapper';
import { describeDevice } from './user-agent.util';

/** Same city/country format the frontend already uses for a lookup's geo section. Unresolvable (a private or
 * loopback address, or the database being unavailable) falls back to the honest "Unknown location". */
const describeLocation = (geo: GeoProvider, ip: string | null): string => {
  if (!ip) {
    return 'Unknown location';
  }
  try {
    const location = geo.locate(ip);
    return (
      [location.city, location.countryCode].filter(Boolean).join(', ') ||
      'Unknown location'
    );
  } catch {
    return 'Unknown location';
  }
};

const DAY_MS = 24 * 60 * 60 * 1000;
const REMEMBERED_SESSION_MS = 30 * DAY_MS;
const DEFAULT_SESSION_MS = DAY_MS;
/** lastActiveAt is only rewritten when it's older than this, so a busy page doesn't cost a write per request. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface NewSessionMeta {
  userAgent?: string;
  ipAddress?: string;
  remember: boolean;
}

export interface ActiveSession {
  sessionId: string;
  user: User;
}

@Injectable()
export class SessionService {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly geo: GeoProvider,
  ) {}

  async create(
    userId: string,
    meta: NewSessionMeta,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = generateToken();
    const expiresAt = new Date(
      Date.now() + (meta.remember ? REMEMBERED_SESSION_MS : DEFAULT_SESSION_MS),
    );

    // Housekeeping while we're here: this user's expired sessions are dead weight.
    await this.db
      .delete(sessions)
      .where(
        and(eq(sessions.userId, userId), lt(sessions.expiresAt, new Date())),
      );

    await this.db.insert(sessions).values({
      userId,
      tokenHash: hashToken(token),
      userAgent: meta.userAgent?.slice(0, 512),
      ipAddress: meta.ipAddress,
      expiresAt,
    });

    return { token, expiresAt };
  }

  /** Resolves a cookie token to its user, or null if the session is unknown, expired, revoked or its owner is suspended. */
  async findActive(token: string): Promise<ActiveSession | null> {
    const [row] = await this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.tokenHash, hashToken(token)),
          gt(sessions.expiresAt, new Date()),
          // Suspending an account also deletes its sessions; this covers one that somehow survives.
          isNull(users.suspendedAt),
        ),
      )
      .limit(1);

    if (!row) {
      return null;
    }

    if (Date.now() - row.session.lastActiveAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db
        .update(sessions)
        .set({ lastActiveAt: new Date() })
        .where(eq(sessions.id, row.session.id));
    }

    return { sessionId: row.session.id, user: toUser(row.user) };
  }

  async revokeByToken(token: string): Promise<void> {
    await this.db
      .delete(sessions)
      .where(eq(sessions.tokenHash, hashToken(token)));
  }

  /** Scoped to `userId` so one user can never revoke another's session by guessing an id. Returns whether a row was removed. */
  async revokeById(userId: string, sessionId: string): Promise<boolean> {
    const removed = await this.db
      .delete(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
      .returning({ id: sessions.id });
    return removed.length > 0;
  }

  /** Signs the user out everywhere, optionally keeping the session making the request. */
  async revokeAllForUser(
    userId: string,
    exceptSessionId?: string,
  ): Promise<void> {
    await this.db
      .delete(sessions)
      .where(
        exceptSessionId
          ? and(eq(sessions.userId, userId), ne(sessions.id, exceptSessionId))
          : eq(sessions.userId, userId),
      );
  }

  async listForUser(
    userId: string,
    currentSessionId?: string,
  ): Promise<SessionInfo[]> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(
        and(eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())),
      )
      .orderBy(desc(sessions.lastActiveAt));

    return rows.map((row) => ({
      id: row.id,
      device: describeDevice(row.userAgent),
      location: describeLocation(this.geo, row.ipAddress),
      lastActiveAt: row.lastActiveAt.toISOString(),
      current: row.id === currentSessionId,
    }));
  }
}
