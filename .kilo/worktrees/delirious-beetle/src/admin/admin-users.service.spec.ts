import type { SessionService } from '../auth/session.service';
import type { AdminUser, User } from '../contracts';
import type { Database } from '../db/database';
import type { UserRow } from '../users/user.mapper';
import type { UsersService } from '../users/users.service';
import {
  AdminUsersService,
  accountStatusOf,
  toAdminUser,
} from './admin-users.service';
import type { AuditService } from './audit.service';

const NOW = new Date('2026-09-26T10:00:00.000Z');

const row = (overrides: Partial<UserRow> = {}): UserRow => ({
  id: 'u_1',
  name: 'Ravi Patel',
  email: 'ravi@example.com',
  passwordHash: 'scrypt$secret',
  plan: 'free',
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

const admin = { id: 'admin_1', email: 'boss@example.com' } as User;

describe('accountStatusOf', () => {
  it('is suspended whatever else is true', () => {
    expect(
      accountStatusOf(row({ suspendedAt: NOW, emailVerified: true })),
    ).toBe('suspended');
    expect(
      accountStatusOf(row({ suspendedAt: NOW, emailVerified: false })),
    ).toBe('suspended');
  });

  it('is pending until the email is verified, and active after', () => {
    expect(accountStatusOf(row({ emailVerified: false }))).toBe('pending');
    expect(accountStatusOf(row({ emailVerified: true }))).toBe('active');
  });
});

describe('toAdminUser', () => {
  it('exposes what the admin table shows and nothing secret', () => {
    const user = toAdminUser(row({ plan: 'pro' }), NOW, 412);

    expect(user).toEqual({
      id: 'u_1',
      name: 'Ravi Patel',
      email: 'ravi@example.com',
      plan: 'pro',
      role: 'user',
      status: 'active',
      lastActiveAt: NOW.toISOString(),
      checks30d: 412,
    });
    expect(JSON.stringify(user)).not.toContain('scrypt');
    expect(JSON.stringify(user)).not.toContain('suspension');
  });
});

const setup = (found?: UserRow) => {
  const users = {
    findById: jest.fn(() => Promise.resolve(found)),
    suspend: jest.fn(() => Promise.resolve(found)),
    reactivate: jest.fn(() => Promise.resolve(found)),
  };
  const sessions = { revokeAllForUser: jest.fn(() => Promise.resolve()) };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new AdminUsersService(
    {} as unknown as Database,
    users as unknown as UsersService,
    sessions as unknown as SessionService,
    audit as unknown as AuditService,
  );
  // What the user looks like afterwards is a database read; the rules under test are what happens before it.
  const described: AdminUser = toAdminUser(row(), NOW, 0);
  const describe = jest
    .spyOn(
      service as unknown as { describe: () => Promise<AdminUser> },
      'describe',
    )
    .mockResolvedValue(described);
  return { service, users, sessions, audit, describe, described };
};

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error('expected a rejection');
};

describe('AdminUsersService.suspend', () => {
  it('marks the account, signs them out everywhere, and writes the audit trail', async () => {
    const { service, users, sessions, audit } = setup(row());

    await service.suspend(admin, 'u_1', '  scraping  ');

    expect(users.suspend).toHaveBeenCalledWith('u_1', 'scraping');
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith('u_1');
    expect(audit.record).toHaveBeenCalledWith(
      admin,
      'user.suspend',
      { type: 'user', id: 'u_1' },
      { email: 'ravi@example.com', reason: 'scraping' },
    );
  });

  it('needs no reason', async () => {
    const { service, users } = setup(row());

    await service.suspend(admin, 'u_1');

    expect(users.suspend).toHaveBeenCalledWith('u_1', null);
  });

  it('turns a blank reason into none', async () => {
    const { service, users } = setup(row());

    await service.suspend(admin, 'u_1', '   ');

    expect(users.suspend).toHaveBeenCalledWith('u_1', null);
  });

  it('refuses to suspend an administrator', async () => {
    const { service, users, sessions } = setup(row({ role: 'admin' }));

    const error = await errorOf(service.suspend(admin, 'u_1'));

    expect(error.code).toBe('CONFLICT');
    expect(users.suspend).not.toHaveBeenCalled();
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('says so when there is no such user', async () => {
    const { service, users } = setup(undefined);

    const error = await errorOf(service.suspend(admin, 'nobody'));

    expect(error.code).toBe('NOT_FOUND');
    expect(users.suspend).not.toHaveBeenCalled();
  });

  it('is harmless to repeat: nothing changes and nothing more is written', async () => {
    const { service, users, sessions, audit } = setup(
      row({ suspendedAt: NOW }),
    );

    await service.suspend(admin, 'u_1');

    expect(users.suspend).not.toHaveBeenCalled();
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('AdminUsersService.reactivate', () => {
  it('lifts the suspension and writes the audit trail', async () => {
    const { service, users, audit } = setup(row({ suspendedAt: NOW }));

    await service.reactivate(admin, 'u_1');

    expect(users.reactivate).toHaveBeenCalledWith('u_1');
    expect(audit.record).toHaveBeenCalledWith(
      admin,
      'user.reactivate',
      { type: 'user', id: 'u_1' },
      { email: 'ravi@example.com' },
    );
  });

  it('does nothing to an account that is not suspended', async () => {
    const { service, users, audit } = setup(row());

    await service.reactivate(admin, 'u_1');

    expect(users.reactivate).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('says so when there is no such user', async () => {
    const { service } = setup(undefined);

    expect((await errorOf(service.reactivate(admin, 'nobody'))).code).toBe(
      'NOT_FOUND',
    );
  });
});
