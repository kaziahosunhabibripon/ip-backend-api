import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { eq } from 'drizzle-orm';
import { ApiException } from '../common/dto/api-exception';
import type { Database } from '../db/database';
import { isUniqueViolation } from '../db/errors';
import { users } from '../db/schema';
import type { UserRow } from './user.mapper';

const EMAIL_TAKEN_MESSAGE =
  'An account with this email already exists. Log in instead.';

@Injectable()
export class UsersService {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  async findById(id: string): Promise<UserRow | undefined> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return row;
  }

  /** Expects an already-normalized (trimmed, lowercase) email. */
  async findByEmail(email: string): Promise<UserRow | undefined> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    return row;
  }

  async create(input: {
    name: string;
    email: string;
    passwordHash: string;
  }): Promise<UserRow> {
    try {
      const [row] = await this.db.insert(users).values(input).returning();
      return row;
    } catch (error) {
      throw this.translate(error);
    }
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        UserRow,
        | 'name'
        | 'email'
        | 'passwordHash'
        | 'emailVerified'
        | 'notificationPreferences'
      >
    >,
  ): Promise<UserRow> {
    try {
      const [row] = await this.db
        .update(users)
        .set(patch)
        .where(eq(users.id, id))
        .returning();
      if (!row) {
        throw new ApiException('NOT_FOUND', 'That account no longer exists.');
      }
      return row;
    } catch (error) {
      throw this.translate(error);
    }
  }

  /** Marks the account suspended. Signing its sessions out is the caller's job: `SessionService` lives in the auth module. */
  async suspend(
    id: string,
    reason: string | null,
    now = new Date(),
  ): Promise<UserRow | undefined> {
    const [row] = await this.db
      .update(users)
      .set({ suspendedAt: now, suspensionReason: reason })
      .where(eq(users.id, id))
      .returning();
    return row;
  }

  async reactivate(id: string): Promise<UserRow | undefined> {
    const [row] = await this.db
      .update(users)
      .set({ suspendedAt: null, suspensionReason: null })
      .where(eq(users.id, id))
      .returning();
    return row;
  }

  /** Sessions, tokens, history, monitors, API keys and billing rows go with it via ON DELETE CASCADE. */
  async delete(id: string): Promise<void> {
    await this.db.delete(users).where(eq(users.id, id));
  }

  private translate(error: unknown): unknown {
    return isUniqueViolation(error)
      ? new ApiException('CONFLICT', EMAIL_TAKEN_MESSAGE)
      : error;
  }
}
