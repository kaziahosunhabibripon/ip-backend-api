import type { User } from '../contracts';
import {
  MAX_NAME_LENGTH,
  defaultTeamName,
  resolveEffectivePlan,
  seatLimitFor,
  toTeam,
  toTeamMember,
  type MemberRow,
} from './team-rules';

describe('defaultTeamName', () => {
  it('names the team after its owner', () => {
    expect(defaultTeamName('Ada Lovelace')).toBe("Ada Lovelace's team");
  });

  it('never exceeds the max length, even for a very long name', () => {
    const name = defaultTeamName('A'.repeat(200));
    expect(name.length).toBe(MAX_NAME_LENGTH);
  });
});

describe('seatLimitFor', () => {
  it('follows the plan, null for a negotiated (Enterprise) size', () => {
    expect(seatLimitFor('free')).toBe(0);
    expect(seatLimitFor('pro')).toBe(0);
    expect(seatLimitFor('business')).toBe(10);
    expect(seatLimitFor('enterprise')).toBeNull();
  });
});

describe('resolveEffectivePlan', () => {
  it('is just the account’s own plan with no team', () => {
    expect(resolveEffectivePlan('free', null)).toBe('free');
    expect(resolveEffectivePlan('business', null)).toBe('business');
  });

  it('elevates to a higher-tier team owner’s plan', () => {
    expect(resolveEffectivePlan('free', 'business')).toBe('business');
    expect(resolveEffectivePlan('pro', 'enterprise')).toBe('enterprise');
  });

  it('never lowers what the account already has of its own', () => {
    expect(resolveEffectivePlan('business', 'pro')).toBe('business');
    expect(resolveEffectivePlan('enterprise', 'free')).toBe('enterprise');
  });

  it('is a no-op at the same tier', () => {
    expect(resolveEffectivePlan('pro', 'pro')).toBe('pro');
  });
});

const memberRow = (overrides: Partial<MemberRow> = {}): MemberRow => ({
  id: 'mem_1',
  status: 'active',
  invitedAt: new Date('2026-09-01T00:00:00.000Z'),
  joinedAt: new Date('2026-09-02T00:00:00.000Z'),
  user: { id: 'u_member', name: 'Sam', email: 'sam@example.test' },
  ...overrides,
});

describe('toTeamMember', () => {
  it('is always role "member", regardless of who reads it', () => {
    expect(toTeamMember(memberRow()).role).toBe('member');
  });

  it('reports null joinedAt for a still-invited row', () => {
    const invited = toTeamMember(
      memberRow({ status: 'invited', joinedAt: null }),
    );
    expect(invited).toMatchObject({ status: 'invited', joinedAt: null });
  });

  it('carries the member’s own name and email, not the id', () => {
    expect(toTeamMember(memberRow())).toMatchObject({
      id: 'mem_1',
      name: 'Sam',
      email: 'sam@example.test',
    });
  });
});

const owner: Pick<User, 'id' | 'name' | 'email' | 'createdAt' | 'plan'> = {
  id: 'u_owner',
  name: 'Owner',
  email: 'owner@example.test',
  createdAt: '2026-01-01T00:00:00.000Z',
  plan: 'business',
};

describe('toTeam', () => {
  it('adds a synthesized owner row, always active, always last', () => {
    const team = toTeam({
      team: { id: 't1', name: 'Acme' },
      owner,
      members: [memberRow()],
      callerId: owner.id,
    });
    expect(team.members).toHaveLength(2);
    expect(team.members[1]).toMatchObject({
      id: owner.id,
      role: 'owner',
      status: 'active',
      invitedAt: owner.createdAt,
      joinedAt: owner.createdAt,
    });
  });

  it('counts seats from the members only, the owner excluded', () => {
    const team = toTeam({
      team: { id: 't1', name: 'Acme' },
      owner,
      members: [memberRow({ id: 'a' }), memberRow({ id: 'b' })],
      callerId: owner.id,
    });
    expect(team.seatsUsed).toBe(2);
  });

  it('takes the seat limit from the owner’s plan', () => {
    const team = toTeam({
      team: { id: 't1', name: 'Acme' },
      owner: { ...owner, plan: 'enterprise' },
      members: [],
      callerId: owner.id,
    });
    expect(team.seatLimit).toBeNull();
  });

  it('is isOwner only for the owner, never for a member reading the same team', () => {
    const asOwner = toTeam({
      team: { id: 't1', name: 'Acme' },
      owner,
      members: [
        memberRow({ user: { id: 'u_member', name: 'Sam', email: 's@x.test' } }),
      ],
      callerId: owner.id,
    });
    const asMember = toTeam({
      team: { id: 't1', name: 'Acme' },
      owner,
      members: [
        memberRow({ user: { id: 'u_member', name: 'Sam', email: 's@x.test' } }),
      ],
      callerId: 'u_member',
    });
    expect(asOwner.isOwner).toBe(true);
    expect(asMember.isOwner).toBe(false);
  });
});
