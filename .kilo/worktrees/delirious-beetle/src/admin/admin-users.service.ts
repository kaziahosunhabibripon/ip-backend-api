import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { SessionService } from '../auth/session.service';
import { ApiException } from '../common/dto/api-exception';
import type {
  AdminUser,
  AdminUsersPage,
  User,
  UserAccountStatus,
} from '../contracts';
import type { Database } from '../db/database';
import { users } from '../db/schema';
import { UsersService } from '../users/users.service';
import type { UserRow } from '../users/user.mapper';
import { AuditService } from './audit.service';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60_000;

export interface ListUsersQuery {
  /** Matched against name and email, case-insensitively. */
  q?: string;
  status?: 'all' | UserAccountStatus;
  limit: number;
  offset: number;
}

/** `pending` is an account whose owner has not confirmed their email yet. */
export const accountStatusOf = (
  row: Pick<UserRow, 'suspendedAt' | 'emailVerified'>,
): UserAccountStatus =>
  row.suspendedAt ? 'suspended' : row.emailVerified ? 'active' : 'pending';

export const toAdminUser = (
  row: UserRow,
  lastActiveAt: Date,
  checks30d: number,
): AdminUser => ({
  id: row.id,
  name: row.name,
  email: row.email,
  plan: row.plan,
  role: row.role,
  status: accountStatusOf(row),
  lastActiveAt: lastActiveAt.toISOString(),
  checks30d,
});

/** `%` and `_` in what an administrator types are text, not wildcards. */
const escapeLike = (text: string) =>
  text.replace(/[\\%_]/g, (char) => `\\${char}`);

@Injectable()
export class AdminUsersService {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly users: UsersService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListUsersQuery, now = new Date()): Promise<AdminUsersPage> {
    const conditions: (SQL | undefined)[] = [];
    const term = query.q?.trim();
    if (term) {
      const pattern = `%${escapeLike(term)}%`;
      conditions.push(
        or(ilike(users.name, pattern), ilike(users.email, pattern)),
      );
    }
    if (query.status === 'suspended') {
      conditions.push(isNotNull(users.suspendedAt));
    } else if (query.status === 'pending') {
      conditions.push(
        isNull(users.suspendedAt),
        eq(users.emailVerified, false),
      );
    } else if (query.status === 'active') {
      conditions.push(isNull(users.suspendedAt), eq(users.emailVerified, true));
    }
    const where = and(...conditions);

    const lastActive = this.lastActive();
    const checks = this.checksSince(new Date(now.getTime() - THIRTY_DAYS_MS));
    const [rows, [count]] = await Promise.all([
      this.db
        .select({ user: users, lastActiveAt: lastActive, checks30d: checks })
        .from(users)
        .where(where)
        .orderBy(desc(lastActive), asc(users.id))
        .limit(query.limit)
        .offset(query.offset),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(users)
        .where(where),
    ]);

    return {
      users: rows.map((row) =>
        toAdminUser(row.user, row.lastActiveAt, row.checks30d),
      ),
      total: count?.total ?? 0,
    };
  }

  async suspend(actor: User, id: string, reason?: string): Promise<AdminUser> {
    const target = await this.users.findById(id);
    if (!target) {
      throw new ApiException('NOT_FOUND', 'That user was not found.');
    }
    if (target.role === 'admin') {
      throw new ApiException(
        'CONFLICT',
        "Administrators can't be suspended. Remove their admin role first.",
      );
    }
    if (target.suspendedAt) {
      return this.describe(id); // already done; repeating it is harmless
    }

    const note = reason?.trim() || null;
    await this.users.suspend(id, note);
    // The next request with any of their cookies is refused: there is no session left to find.
    await this.sessions.revokeAllForUser(id);
    await this.audit.record(
      actor,
      'user.suspend',
      { type: 'user', id },
      {
        email: target.email,
        reason: note,
      },
    );
    return this.describe(id);
  }

  async reactivate(actor: User, id: string): Promise<AdminUser> {
    const target = await this.users.findById(id);
    if (!target) {
      throw new ApiException('NOT_FOUND', 'That user was not found.');
    }
    if (target.suspendedAt) {
      await this.users.reactivate(id);
      await this.audit.record(
        actor,
        'user.reactivate',
        { type: 'user', id },
        {
          email: target.email,
        },
      );
    }
    return this.describe(id);
  }

  /** One user, in the shape of the list. */
  private async describe(id: string): Promise<AdminUser> {
    const lastActive = this.lastActive();
    const [row] = await this.db
      .select({
        user: users,
        lastActiveAt: lastActive,
        checks30d: this.checksSince(new Date(Date.now() - THIRTY_DAYS_MS)),
      })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    if (!row) {
      throw new ApiException('NOT_FOUND', 'That user was not found.');
    }
    return toAdminUser(row.user, row.lastActiveAt, row.checks30d);
  }

  /**
   * The latest of: any session's last activity, the last lookup, and sign-up — so a user who has signed out is not
   * "last seen at sign-up". The outer table is named in full ("users"."id"): a select over one table leaves its
   * columns unqualified, and inside a subquery a bare `id` would quietly mean the subquery's own.
   */
  private lastActive() {
    return sql`greatest(
      coalesce((select max(s.last_active_at) from sessions s where s.user_id = "users"."id"), "users"."created_at"),
      coalesce((select max(e.at) from lookup_events e where e.user_id = "users"."id"), "users"."created_at")
    )`.mapWith(users.createdAt);
  }

  private checksSince(since: Date) {
    return sql<number>`(select count(*)::int from lookup_events e where e.user_id = "users"."id" and e.at >= ${since.toISOString()}::timestamp)`;
  }
}
