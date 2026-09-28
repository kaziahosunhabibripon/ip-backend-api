import { Injectable, Logger } from '@nestjs/common';
import { ApiException } from '../common/dto/api-exception';
import type { User } from '../contracts';
import { toUser, type UserRow } from '../users/user.mapper';
import { UsersService } from '../users/users.service';
import { AuthMailService } from './auth-mail.service';
import {
  AuthTokenService,
  EMAIL_VERIFICATION_TTL_MS,
  PASSWORD_RESET_TTL_MS,
} from './auth-token.service';
import type { ForgotPasswordDto } from './dto/forgot-password.dto';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';
import type { ResetPasswordDto } from './dto/reset-password.dto';
import { PasswordService } from './password.service';
import type { RequestMeta } from './request-meta';
import { SessionService } from './session.service';

export interface IssuedSession {
  user: User;
  token: string;
  expiresAt: Date;
  /** True for "remember me" — the cookie should outlive the browser session. */
  persistent: boolean;
}

const INVALID_LINK = () =>
  new ApiException(
    'INVALID_INPUT',
    'This link is invalid or has expired. Request a new one.',
    { reason: 'invalid_token' },
  );

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly tokens: AuthTokenService,
    private readonly authMail: AuthMailService,
  ) {}

  async register(dto: RegisterDto, meta: RequestMeta): Promise<IssuedSession> {
    const passwordHash = await this.passwords.hash(dto.password);
    const row = await this.users.create({
      name: dto.name,
      email: dto.email,
      passwordHash,
    });

    this.queueVerificationEmail(row);
    return this.startSession(row, meta, false);
  }

  async login(dto: LoginDto, meta: RequestMeta): Promise<IssuedSession> {
    const row = await this.users.findByEmail(dto.email);

    let valid = false;
    if (row) {
      valid = await this.passwords.verify(dto.password, row.passwordHash);
    } else {
      await this.passwords.verifyAgainstDummy(dto.password);
    }

    if (!row || !valid) {
      throw new ApiException(
        'INVALID_CREDENTIALS',
        'Incorrect email or password.',
      );
    }

    // Only after the password checks out, so a stranger can't use this to learn which accounts are suspended.
    if (row.suspendedAt) {
      throw new ApiException(
        'FORBIDDEN',
        'This account has been suspended. Contact support if you think this is a mistake.',
      );
    }

    return this.startSession(row, meta, dto.remember ?? false);
  }

  async logout(sessionToken: string | undefined): Promise<void> {
    if (sessionToken) {
      await this.sessions.revokeByToken(sessionToken);
    }
  }

  /** Always resolves the same way whether or not the email is registered, so it can't be used to probe for accounts. */
  async requestPasswordReset(dto: ForgotPasswordDto): Promise<void> {
    const row = await this.users.findByEmail(dto.email);
    if (!row) {
      return;
    }

    void this.tokens
      .issue(row.id, 'password_reset', PASSWORD_RESET_TTL_MS)
      .then((token) =>
        this.authMail.sendPasswordReset(row.email, row.name, token),
      )
      .catch((error: unknown) => this.logQueueFailure('password reset', error));
  }

  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    const userId = await this.tokens.consume(dto.token, 'password_reset');
    if (!userId) {
      throw INVALID_LINK();
    }

    const passwordHash = await this.passwords.hash(dto.password);
    await this.users.update(userId, { passwordHash });
    // Whoever knew the old password (or stole a session) is signed out everywhere.
    await this.sessions.revokeAllForUser(userId);
  }

  async verifyEmail(token: string): Promise<void> {
    const userId = await this.tokens.consume(token, 'email_verification');
    if (!userId) {
      throw INVALID_LINK();
    }

    await this.users.update(userId, { emailVerified: true });
  }

  async resendVerification(userId: string): Promise<void> {
    const row = await this.users.findById(userId);
    if (!row || row.emailVerified) {
      return;
    }

    this.queueVerificationEmail(row);
  }

  /** Issues a fresh verification link and emails it without making the caller wait or fail on a mail problem. */
  queueVerificationEmail(row: Pick<UserRow, 'id' | 'name' | 'email'>): void {
    void this.tokens
      .issue(row.id, 'email_verification', EMAIL_VERIFICATION_TTL_MS)
      .then((token) =>
        this.authMail.sendVerification(row.email, row.name, token),
      )
      .catch((error: unknown) => this.logQueueFailure('verification', error));
  }

  private async startSession(
    row: UserRow,
    meta: RequestMeta,
    remember: boolean,
  ): Promise<IssuedSession> {
    const { token, expiresAt } = await this.sessions.create(row.id, {
      ...meta,
      remember,
    });

    return { user: toUser(row), token, expiresAt, persistent: remember };
  }

  private logQueueFailure(kind: string, error: unknown) {
    this.logger.error(
      `Could not queue ${kind} email: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
