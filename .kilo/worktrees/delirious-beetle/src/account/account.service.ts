import { Injectable } from '@nestjs/common';
import { ApiException } from '../common/dto/api-exception';
import { AuthService } from '../auth/auth.service';
import { PasswordService } from '../auth/password.service';
import { SessionService } from '../auth/session.service';
import type { NotificationPreferences, SessionInfo, User } from '../contracts';
import { toUser } from '../users/user.mapper';
import { UsersService } from '../users/users.service';
import type { ChangePasswordDto } from './dto/change-password.dto';
import type { UpdateNotificationsDto } from './dto/notification-preferences.dto';
import type { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class AccountService {
  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly auth: AuthService,
  ) {}

  async updateProfile(user: User, dto: UpdateProfileDto): Promise<User> {
    const emailChanged = dto.email !== user.email;
    const row = await this.users.update(user.id, {
      name: dto.name,
      email: dto.email,
      // A new address hasn't proven it's the user's yet.
      ...(emailChanged ? { emailVerified: false } : {}),
    });

    if (emailChanged) {
      this.auth.queueVerificationEmail(row);
    }

    return toUser(row);
  }

  async changePassword(
    user: User,
    currentSessionId: string | undefined,
    dto: ChangePasswordDto,
  ): Promise<void> {
    const row = await this.users.findById(user.id);
    if (
      !row ||
      !(await this.passwords.verify(dto.currentPassword, row.passwordHash))
    ) {
      throw new ApiException(
        'INVALID_CREDENTIALS',
        'Your current password is incorrect.',
      );
    }

    const passwordHash = await this.passwords.hash(dto.newPassword);
    await this.users.update(user.id, { passwordHash });
    // Sign out every other device; this one stays logged in.
    await this.sessions.revokeAllForUser(user.id, currentSessionId);
  }

  async getNotifications(userId: string): Promise<NotificationPreferences> {
    const row = await this.users.findById(userId);
    if (!row) {
      throw new ApiException('NOT_FOUND', 'That account no longer exists.');
    }

    return row.notificationPreferences;
  }

  async updateNotifications(
    userId: string,
    patch: UpdateNotificationsDto,
  ): Promise<NotificationPreferences> {
    const current = await this.getNotifications(userId);
    const changes = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as Partial<NotificationPreferences>;

    const row = await this.users.update(userId, {
      notificationPreferences: { ...current, ...changes },
    });
    return row.notificationPreferences;
  }

  listSessions(
    userId: string,
    currentSessionId: string | undefined,
  ): Promise<SessionInfo[]> {
    return this.sessions.listForUser(userId, currentSessionId);
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const removed = await this.sessions.revokeById(userId, sessionId);
    if (!removed) {
      throw new ApiException('NOT_FOUND', "We couldn't find that session.");
    }
  }

  deleteAccount(userId: string): Promise<void> {
    // Nothing to cancel elsewhere: plans are paid a period at a time and never renew by themselves.
    return this.users.delete(userId);
  }
}
