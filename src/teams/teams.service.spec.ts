import type { AuthTokenService } from '../auth/auth-token.service';
import { ApiException } from '../common/dto/api-exception';
import type { User } from '../contracts';
import type { TeamMailService } from './team-mail.service';
import { TeamsService } from './teams.service';
import type { TeamsStore } from './teams-store.service';

const user = (overrides: Partial<User> = {}): User => ({
  id: 'u_owner',
  name: 'Owner',
  email: 'owner@example.test',
  role: 'user',
  plan: 'business',
  effectivePlan: 'business',
  emailVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const team = { id: 't1', name: 'Acme' };

const setup = (overrides: Partial<Record<string, jest.Mock>> = {}) => {
  const store = {
    findByOwnerId: jest.fn(() => Promise.resolve(null)),
    findMembershipTeam: jest.fn(() => Promise.resolve(null)),
    findActiveOwnerPlan: jest.fn(() => Promise.resolve(null)),
    listMembers: jest.fn(() => Promise.resolve([])),
    createTeam: jest.fn(() => Promise.resolve(team)),
    renameTeam: jest.fn(() => Promise.resolve()),
    deleteTeam: jest.fn(() => Promise.resolve()),
    inviteMember: jest.fn(() => Promise.resolve()),
    findMemberById: jest.fn(() => Promise.resolve(null)),
    removeMember: jest.fn(() => Promise.resolve()),
    removeMemberByUserId: jest.fn(() => Promise.resolve(false)),
    activate: jest.fn(() => Promise.resolve()),
    userById: jest.fn(() => Promise.resolve(undefined)),
    userByEmail: jest.fn(() => Promise.resolve(undefined)),
    ownerUser: jest.fn(() => Promise.resolve(null)),
    ...overrides,
  };
  const tokens = {
    issue: jest.fn(() => Promise.resolve('plaintoken')),
    verify: jest.fn(() => Promise.resolve(null)),
    consume: jest.fn(() => Promise.resolve(null)),
  };
  const mail = {
    sendInvite: jest.fn(() => Promise.resolve()),
    notifyRemoved: jest.fn(() => Promise.resolve()),
  };
  const service = new TeamsService(
    store as unknown as TeamsStore,
    tokens as unknown as AuthTokenService,
    mail as unknown as TeamMailService,
  );
  return { service, store, tokens, mail };
};

const rejects = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    return error as ApiException;
  }
  throw new Error('expected a rejection');
};

describe('TeamsService.effectivePlan', () => {
  it('is the account’s own plan when it belongs to no team', async () => {
    const { service, store } = setup({
      findActiveOwnerPlan: jest.fn(() => Promise.resolve(null)),
    });
    await expect(service.effectivePlan(user({ plan: 'free' }))).resolves.toBe(
      'free',
    );
    expect(store.findActiveOwnerPlan).toHaveBeenCalledWith('u_owner');
  });

  it('elevates to an active team’s higher plan', async () => {
    const { service } = setup({
      findActiveOwnerPlan: jest.fn(() => Promise.resolve('enterprise')),
    });
    await expect(
      service.effectivePlan(user({ id: 'u_member', plan: 'free' })),
    ).resolves.toBe('enterprise');
  });

  it('caches the answer, and does not ask again within the window', async () => {
    const { service, store } = setup({
      findActiveOwnerPlan: jest.fn(() => Promise.resolve('business')),
    });
    const member = user({ id: 'u_member', plan: 'free' });
    await service.effectivePlan(member);
    await service.effectivePlan(member);
    expect(store.findActiveOwnerPlan).toHaveBeenCalledTimes(1);
  });

  it('falls back to the account’s own plan when the lookup fails, instead of throwing', async () => {
    const { service } = setup({
      findActiveOwnerPlan: jest.fn(() => Promise.reject(new Error('down'))),
    });
    await expect(service.effectivePlan(user({ plan: 'pro' }))).resolves.toBe(
      'pro',
    );
  });
});

describe('TeamsService.create', () => {
  it('creates a team named after the owner by default', async () => {
    const { service, store } = setup();
    await service.create(user(), undefined);
    expect(store.createTeam).toHaveBeenCalledWith('u_owner', "Owner's team");
  });

  it('trims and uses a given name', async () => {
    const { service, store } = setup();
    await service.create(user(), '  Rocket squad  ');
    expect(store.createTeam).toHaveBeenCalledWith('u_owner', 'Rocket squad');
  });

  it('refuses a second team for the same owner', async () => {
    const { service } = setup({
      findByOwnerId: jest.fn(() => Promise.resolve(team)),
    });
    expect((await rejects(service.create(user(), undefined))).code).toBe(
      'CONFLICT',
    );
  });

  it('refuses to create a team while already a member of someone else’s', async () => {
    const { service } = setup({
      findMembershipTeam: jest.fn(() =>
        Promise.resolve({ team, ownerId: 'someone-else', membershipId: 'm1' }),
      ),
    });
    expect((await rejects(service.create(user(), undefined))).code).toBe(
      'CONFLICT',
    );
  });
});

describe('TeamsService.invite', () => {
  // Only "u_owner" owns a team; every other id (the invitee, checked separately) owns none.
  const withTeam = (extra: Partial<Record<string, jest.Mock>> = {}) =>
    setup({
      findByOwnerId: jest.fn((ownerId: string) =>
        Promise.resolve(ownerId === 'u_owner' ? team : null),
      ),
      ...extra,
    });

  it('refuses an email with no IPScope account', async () => {
    const { service } = withTeam({
      userByEmail: jest.fn(() => Promise.resolve(undefined)),
    });
    const error = await rejects(service.invite(user(), 'nobody@example.test'));
    expect(error.code).toBe('INVALID_INPUT');
  });

  it('refuses inviting yourself', async () => {
    const { service } = withTeam({
      userByEmail: jest.fn(() =>
        Promise.resolve({
          id: 'u_owner',
          name: 'Owner',
          email: 'owner@example.test',
        }),
      ),
    });
    expect(
      (await rejects(service.invite(user(), 'owner@example.test'))).code,
    ).toBe('INVALID_INPUT');
  });

  it('refuses inviting someone who owns their own team', async () => {
    const invitee = { id: 'u2', name: 'Other', email: 'other@example.test' };
    const { service } = withTeam({
      userByEmail: jest.fn(() => Promise.resolve(invitee)),
      findByOwnerId: jest
        .fn()
        .mockResolvedValueOnce(team) // the caller's own team
        .mockResolvedValueOnce({ id: 't2', name: 'Their team' }), // the invitee owns one too
    });
    expect(
      (await rejects(service.invite(user(), 'other@example.test'))).code,
    ).toBe('CONFLICT');
  });

  it('refuses re-inviting someone already invited to this team', async () => {
    const invitee = { id: 'u2', name: 'Other', email: 'other@example.test' };
    const { service } = withTeam({
      userByEmail: jest.fn(() => Promise.resolve(invitee)),
      findMembershipTeam: jest.fn(() =>
        Promise.resolve({ team, ownerId: 'u_owner', membershipId: 'm1' }),
      ),
    });
    expect(
      (await rejects(service.invite(user(), 'other@example.test'))).code,
    ).toBe('CONFLICT');
  });

  it('refuses someone already on a different team', async () => {
    const invitee = { id: 'u2', name: 'Other', email: 'other@example.test' };
    const otherTeam = { id: 't2', name: 'Elsewhere' };
    const { service } = withTeam({
      userByEmail: jest.fn(() => Promise.resolve(invitee)),
      findMembershipTeam: jest.fn(() =>
        Promise.resolve({
          team: otherTeam,
          ownerId: 'someone-else',
          membershipId: 'm1',
        }),
      ),
    });
    expect(
      (await rejects(service.invite(user(), 'other@example.test'))).code,
    ).toBe('CONFLICT');
  });

  it('refuses past the plan’s seat limit', async () => {
    const invitee = { id: 'u2', name: 'Other', email: 'other@example.test' };
    const members = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`,
      status: 'active' as const,
      invitedAt: new Date(),
      joinedAt: new Date(),
      user: { id: `u${i}`, name: `U${i}`, email: `u${i}@example.test` },
    }));
    const { service } = withTeam({
      userByEmail: jest.fn(() => Promise.resolve(invitee)),
      listMembers: jest.fn(() => Promise.resolve(members)),
    });
    const error = await rejects(service.invite(user(), 'other@example.test'));
    expect(error.code).toBe('CONFLICT');
    expect(error.details).toMatchObject({ limit: 10 });
  });

  it('invites, issues a token and emails it — using the owner’s own plan for the seat limit, not an elevated one', async () => {
    const invitee = { id: 'u2', name: 'Other', email: 'other@example.test' };
    const { service, store, tokens, mail } = withTeam({
      userByEmail: jest.fn(() => Promise.resolve(invitee)),
    });
    await service.invite(
      user({ plan: 'business', effectivePlan: 'enterprise' }),
      'OTHER@Example.test',
    );

    expect(store.userByEmail).toHaveBeenCalledWith('other@example.test');
    expect(store.inviteMember).toHaveBeenCalledWith('t1', 'u2');
    expect(tokens.issue).toHaveBeenCalledWith(
      'u2',
      'team_invite',
      expect.any(Number),
    );
    expect(mail.sendInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'other@example.test',
        token: 'plaintoken',
      }),
    );
  });

  it('answers 404 when the caller has no team yet', async () => {
    const { service } = setup();
    expect((await rejects(service.invite(user(), 'x@example.test'))).code).toBe(
      'NOT_FOUND',
    );
  });
});

describe('TeamsService.remove', () => {
  it('deletes the team and notifies every member', async () => {
    const members = [
      {
        id: 'm1',
        status: 'active' as const,
        invitedAt: new Date(),
        joinedAt: new Date(),
        user: { id: 'u2', name: 'Sam', email: 'sam@example.test' },
      },
    ];
    const { service, store, mail } = setup({
      findByOwnerId: jest.fn(() => Promise.resolve(team)),
      listMembers: jest.fn(() => Promise.resolve(members)),
    });
    await service.remove(user());
    expect(store.deleteTeam).toHaveBeenCalledWith('t1');
    expect(mail.notifyRemoved).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'sam@example.test' }),
    );
  });
});

describe('TeamsService.removeMember', () => {
  it('answers 404 for a member id that belongs to a different team', async () => {
    const { service } = setup({
      findByOwnerId: jest.fn(() => Promise.resolve(team)),
      findMemberById: jest.fn(() =>
        Promise.resolve({
          id: 'm1',
          teamId: 'someone-elses-team',
          userId: 'u2',
        }),
      ),
    });
    expect((await rejects(service.removeMember(user(), 'm1'))).code).toBe(
      'NOT_FOUND',
    );
  });

  it('removes the member and emails them', async () => {
    const removedUser = { id: 'u2', name: 'Sam', email: 'sam@example.test' };
    const { service, store, mail } = setup({
      findByOwnerId: jest.fn(() => Promise.resolve(team)),
      findMemberById: jest.fn(() =>
        Promise.resolve({ id: 'm1', teamId: 't1', userId: 'u2' }),
      ),
      userById: jest.fn(() => Promise.resolve(removedUser)),
    });
    await service.removeMember(user(), 'm1');
    expect(store.removeMember).toHaveBeenCalledWith('m1');
    expect(mail.notifyRemoved).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'sam@example.test' }),
    );
  });
});

describe('TeamsService.leave', () => {
  it('refuses an owner — they must delete the team instead', async () => {
    const { service } = setup({
      findByOwnerId: jest.fn(() => Promise.resolve(team)),
    });
    expect((await rejects(service.leave(user()))).code).toBe('CONFLICT');
  });

  it('answers 404 for someone on no team', async () => {
    const { service } = setup({
      removeMemberByUserId: jest.fn(() => Promise.resolve(false)),
    });
    expect((await rejects(service.leave(user()))).code).toBe('NOT_FOUND');
  });

  it('removes the membership', async () => {
    const { service, store } = setup({
      removeMemberByUserId: jest.fn(() => Promise.resolve(true)),
    });
    await service.leave(user({ id: 'u_member' }));
    expect(store.removeMemberByUserId).toHaveBeenCalledWith('u_member');
  });
});

describe('TeamsService.accept', () => {
  it('refuses an unknown or expired token', async () => {
    const { service } = setup({});
    expect((await rejects(service.accept(user(), 'bad-token'))).code).toBe(
      'INVALID_INPUT',
    );
  });

  it('refuses a token addressed to someone else — and never even spends it', async () => {
    const { service, tokens } = setup();
    (tokens.verify as jest.Mock).mockResolvedValue('someone-else');
    expect(
      (await rejects(service.accept(user({ id: 'u_member' }), 'tok'))).code,
    ).toBe('INVALID_INPUT');
    expect(tokens.consume).not.toHaveBeenCalled();
  });

  it('activates the membership and returns the team, keyed by the owner’s current plan', async () => {
    const owner = user({
      id: 'u_owner',
      plan: 'business',
      effectivePlan: 'business',
    });
    const membership = { team, ownerId: 'u_owner', membershipId: 'm1' };
    const { service, store, tokens } = setup({
      findMembershipTeam: jest.fn(() => Promise.resolve(membership)),
      ownerUser: jest.fn(() => Promise.resolve(owner)),
    });
    (tokens.verify as jest.Mock).mockResolvedValue('u_member');
    (tokens.consume as jest.Mock).mockResolvedValue('u_member');

    const view = await service.accept(user({ id: 'u_member' }), 'tok');

    expect(store.activate).toHaveBeenCalledWith('m1', expect.any(Date));
    expect(view.seatLimit).toBe(10); // business
    expect(view.isOwner).toBe(false);
  });

  it('refuses cleanly if the very same link is accepted twice at once — the second consume finds it already gone', async () => {
    const membership = { team, ownerId: 'u_owner', membershipId: 'm1' };
    const { service, tokens } = setup({
      findMembershipTeam: jest.fn(() => Promise.resolve(membership)),
    });
    (tokens.verify as jest.Mock).mockResolvedValue('u_member');
    (tokens.consume as jest.Mock).mockResolvedValue(null);

    expect(
      (await rejects(service.accept(user({ id: 'u_member' }), 'tok'))).code,
    ).toBe('INVALID_INPUT');
  });
});
