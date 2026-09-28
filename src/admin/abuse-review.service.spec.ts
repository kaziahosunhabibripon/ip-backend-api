import type { AbuseService } from '../abuse/abuse.service';
import type { AbuseFlagRow, AbuseStore } from '../abuse/abuse-store.service';
import { ApiException } from '../common/dto/api-exception';
import type { ApiKeysStore } from '../api-keys/api-keys-store.service';
import type { User } from '../contracts';
import { AbuseReviewService } from './abuse-review.service';
import type { AdminUsersService } from './admin-users.service';
import type { AuditService } from './audit.service';

const NOW = new Date('2026-09-26T10:00:00.000Z');
const admin = { id: 'admin_1', email: 'boss@example.com' } as User;

const flag = (overrides: Partial<AbuseFlagRow> = {}): AbuseFlagRow => ({
  id: 'flag_1',
  kind: 'account',
  subjectKey: 'u_9',
  subjectLabel: 'ravi@example.com',
  reason: 'internal_targets',
  severity: 'high',
  events: 58,
  eventsAtDecision: 0,
  firstSeenAt: NOW,
  lastSeenAt: NOW,
  status: 'open',
  decidedBy: null,
  decidedAt: null,
  ...overrides,
});

const setup = (current: AbuseFlagRow | undefined) => {
  const flags = {
    get: jest.fn(() => Promise.resolve(current)),
    decide: jest.fn((_id: string, status: AbuseFlagRow['status']) =>
      Promise.resolve(current ? { ...current, status } : undefined),
    ),
  };
  const abuse = {
    blockVisitor: jest.fn(() => Promise.resolve()),
    unblockVisitor: jest.fn(() => Promise.resolve()),
  };
  const users = {
    suspend: jest.fn(() => Promise.resolve({})),
    reactivate: jest.fn(() => Promise.resolve({})),
  };
  const keys = {
    revokeAny: jest.fn((): Promise<object | undefined> => Promise.resolve({})),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new AbuseReviewService(
    flags as unknown as AbuseStore,
    abuse as unknown as AbuseService,
    users as unknown as AdminUsersService,
    keys as unknown as ApiKeysStore,
    audit as unknown as AuditService,
  );
  return { service, flags, abuse, users, keys, audit };
};

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as ApiException;
  }
  throw new Error('expected a rejection');
};

describe('AbuseReviewService — block', () => {
  it('suspends the account behind an account flag', async () => {
    const { service, users, flags } = setup(flag({ kind: 'account' }));

    const result = await service.decide(admin, 'flag_1', 'block');

    expect(users.suspend).toHaveBeenCalledWith(
      admin,
      'u_9',
      'Blocked after an abuse review',
    );
    expect(flags.decide).toHaveBeenCalledWith('flag_1', 'blocked', 'admin_1');
    expect(result).toMatchObject({ id: 'flag_1', status: 'blocked' });
  });

  it('revokes the key behind an API key flag', async () => {
    const { service, keys } = setup(
      flag({ kind: 'api_key', subjectKey: 'key_7' }),
    );

    await service.decide(admin, 'flag_1', 'block');

    expect(keys.revokeAny).toHaveBeenCalledWith('key_7', expect.any(Date));
  });

  it('refuses anonymous lookups from the network behind a network flag', async () => {
    const { service, abuse } = setup(
      flag({ kind: 'ip_address', subjectKey: 'hash_1' }),
    );

    await service.decide(admin, 'flag_1', 'block');

    expect(abuse.blockVisitor).toHaveBeenCalledWith(
      'hash_1',
      expect.stringContaining('internal or reserved targets'),
      'admin_1',
    );
  });

  it('does not mark the flag blocked when blocking could not be done', async () => {
    const { service, users, flags } = setup(flag());
    users.suspend.mockRejectedValueOnce(
      new ApiException('CONFLICT', "Administrators can't be suspended."),
    );

    const error = await errorOf(service.decide(admin, 'flag_1', 'block'));

    expect(error.code).toBe('CONFLICT');
    expect(flags.decide).not.toHaveBeenCalled();
  });

  it('says so when the key is already gone', async () => {
    const { service, keys, flags } = setup(flag({ kind: 'api_key' }));
    keys.revokeAny.mockResolvedValueOnce(undefined);

    const error = await errorOf(service.decide(admin, 'flag_1', 'block'));

    expect(error.code).toBe('CONFLICT');
    expect(flags.decide).not.toHaveBeenCalled();
  });

  it('is harmless to repeat on something already blocked', async () => {
    const { service, users, keys, abuse } = setup(flag({ status: 'blocked' }));

    await service.decide(admin, 'flag_1', 'block');

    expect(users.suspend).not.toHaveBeenCalled();
    expect(keys.revokeAny).not.toHaveBeenCalled();
    expect(abuse.blockVisitor).not.toHaveBeenCalled();
  });
});

describe('AbuseReviewService — dismiss', () => {
  it('only changes the flag', async () => {
    const { service, users, keys, abuse, flags } = setup(flag());

    const result = await service.decide(admin, 'flag_1', 'dismiss');

    expect(result.status).toBe('dismissed');
    expect(flags.decide).toHaveBeenCalledWith('flag_1', 'dismissed', 'admin_1');
    expect(users.suspend).not.toHaveBeenCalled();
    expect(keys.revokeAny).not.toHaveBeenCalled();
    expect(abuse.blockVisitor).not.toHaveBeenCalled();
  });

  it('is refused on a blocked flag, which has to be reopened first', async () => {
    const { service, flags } = setup(flag({ status: 'blocked' }));

    const error = await errorOf(service.decide(admin, 'flag_1', 'dismiss'));

    expect(error.code).toBe('CONFLICT');
    expect(flags.decide).not.toHaveBeenCalled();
  });
});

describe('AbuseReviewService — reopen', () => {
  it('reactivates the account when an account block is lifted', async () => {
    const { service, users, flags } = setup(flag({ status: 'blocked' }));

    const result = await service.decide(admin, 'flag_1', 'reopen');

    expect(users.reactivate).toHaveBeenCalledWith(admin, 'u_9');
    expect(flags.decide).toHaveBeenCalledWith('flag_1', 'open', 'admin_1');
    expect(result.status).toBe('open');
  });

  it('unblocks the network when a network block is lifted', async () => {
    const { service, abuse } = setup(
      flag({ kind: 'ip_address', subjectKey: 'hash_1', status: 'blocked' }),
    );

    await service.decide(admin, 'flag_1', 'reopen');

    expect(abuse.unblockVisitor).toHaveBeenCalledWith('hash_1');
  });

  it('can not restore a revoked key, and leaves the flag as it was', async () => {
    const { service, flags } = setup(
      flag({ kind: 'api_key', status: 'blocked' }),
    );

    const error = await errorOf(service.decide(admin, 'flag_1', 'reopen'));

    expect(error.code).toBe('CONFLICT');
    expect(error.message).toContain('create a new one');
    expect(flags.decide).not.toHaveBeenCalled();
  });

  it('brings a dismissed flag back without touching anything', async () => {
    const { service, users, abuse } = setup(flag({ status: 'dismissed' }));

    const result = await service.decide(admin, 'flag_1', 'reopen');

    expect(result.status).toBe('open');
    expect(users.reactivate).not.toHaveBeenCalled();
    expect(abuse.unblockVisitor).not.toHaveBeenCalled();
  });
});

describe('AbuseReviewService', () => {
  it('says so when the flag does not exist', async () => {
    const { service } = setup(undefined);

    expect((await errorOf(service.decide(admin, 'nope', 'block'))).code).toBe(
      'NOT_FOUND',
    );
  });

  it('writes what was decided, about what, to the audit trail', async () => {
    const { service, audit } = setup(flag());

    await service.decide(admin, 'flag_1', 'dismiss');

    expect(audit.record).toHaveBeenCalledWith(
      admin,
      'abuse.dismiss',
      { type: 'abuse_flag', id: 'flag_1' },
      {
        kind: 'account',
        subject: 'ravi@example.com',
        reason: 'internal_targets',
      },
    );
  });
});
