import type { ApiException } from '../common/dto/api-exception';
import type { UserRow } from '../users/user.mapper';
import type { UsersService } from '../users/users.service';
import type { AuthMailService } from './auth-mail.service';
import { AuthService } from './auth.service';
import type { AuthTokenService } from './auth-token.service';
import type { PasswordService } from './password.service';
import type { SessionService } from './session.service';

const row = (overrides: Partial<UserRow> = {}): UserRow => ({
  id: 'u_1',
  name: 'Ada',
  email: 'ada@example.com',
  passwordHash: 'scrypt$hash',
  plan: 'pro',
  role: 'user',
  emailVerified: true,
  notificationPreferences: {
    monitorAlerts: true,
    securityAlerts: true,
    weeklyDigest: false,
    usageWarnings: true,
    productUpdates: false,
  },
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  suspendedAt: null,
  suspensionReason: null,
  ...overrides,
});

const setup = (found: UserRow | undefined, passwordOk = true) => {
  const users = { findByEmail: jest.fn(() => Promise.resolve(found)) };
  const passwords = {
    verify: jest.fn(() => Promise.resolve(passwordOk)),
    verifyAgainstDummy: jest.fn(() => Promise.resolve()),
  };
  const sessions = {
    create: jest.fn(() =>
      Promise.resolve({
        token: 'tok',
        expiresAt: new Date('2026-10-01T00:00:00.000Z'),
      }),
    ),
  };
  const service = new AuthService(
    users as unknown as UsersService,
    passwords as unknown as PasswordService,
    sessions as unknown as SessionService,
    {} as unknown as AuthTokenService,
    {} as unknown as AuthMailService,
  );
  return { service, users, passwords, sessions };
};

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as ApiException;
  }
  throw new Error('expected a rejection');
};

const credentials = { email: 'ada@example.com', password: 'Sup3r-secret-pw' };

describe('AuthService.login', () => {
  it('signs a user in with the right password', async () => {
    const { service, sessions } = setup(row());

    const issued = await service.login(credentials, {});

    expect(issued.token).toBe('tok');
    expect(sessions.create).toHaveBeenCalledTimes(1);
  });

  it('refuses a suspended account with FORBIDDEN and a clear message, and issues no session', async () => {
    const { service, sessions } = setup(
      row({ suspendedAt: new Date('2026-09-25T00:00:00.000Z') }),
    );

    const error = await errorOf(service.login(credentials, {}));

    expect(error.code).toBe('FORBIDDEN');
    expect(error.status).toBe(403);
    expect(error.message).toContain('suspended');
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('does not tell a stranger which accounts are suspended: a wrong password is just "incorrect"', async () => {
    const { service, sessions } = setup(
      row({ suspendedAt: new Date() }),
      false,
    );

    const error = await errorOf(
      service.login({ ...credentials, password: 'not-the-password' }, {}),
    );

    expect(error.code).toBe('INVALID_CREDENTIALS');
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('answers an unknown email exactly like a wrong password', async () => {
    const { service, passwords } = setup(undefined);

    const error = await errorOf(service.login(credentials, {}));

    expect(error.code).toBe('INVALID_CREDENTIALS');
    expect(passwords.verifyAgainstDummy).toHaveBeenCalled();
  });
});
