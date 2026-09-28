import type { Plan, Team, TeamMember, User } from '../contracts';
import { PLAN_LIMITS, PLAN_ORDER } from '../common/plans';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_NAME_LENGTH = 80;

export const defaultTeamName = (ownerName: string): string =>
  `${ownerName}'s team`.slice(0, MAX_NAME_LENGTH);

/** Seats a team may hold on this plan, the owner not counted. */
export const seatLimitFor = (plan: Plan): number | null =>
  PLAN_LIMITS[plan].teamSeats;

/** What the caller may actually use right now: their own plan, or a team owner's if it is higher. Never lower. */
export const resolveEffectivePlan = (
  ownPlan: Plan,
  ownerPlan: Plan | null,
): Plan => {
  if (!ownerPlan) {
    return ownPlan;
  }
  return PLAN_ORDER.indexOf(ownerPlan) > PLAN_ORDER.indexOf(ownPlan)
    ? ownerPlan
    : ownPlan;
};

export interface MemberRow {
  id: string;
  status: 'invited' | 'active';
  invitedAt: Date;
  joinedAt: Date | null;
  user: Pick<User, 'id' | 'name' | 'email'>;
}

export interface TeamRow {
  id: string;
  name: string;
}

export const toTeamMember = (row: MemberRow): TeamMember => ({
  id: row.id,
  name: row.user.name,
  email: row.user.email,
  role: 'member',
  status: row.status,
  invitedAt: row.invitedAt.toISOString(),
  joinedAt: row.joinedAt?.toISOString() ?? null,
});

const ownerMember = (
  owner: Pick<User, 'id' | 'name' | 'email' | 'createdAt'>,
): TeamMember => ({
  id: owner.id,
  name: owner.name,
  email: owner.email,
  role: 'owner',
  status: 'active',
  invitedAt: owner.createdAt,
  joinedAt: owner.createdAt,
});

export const toTeam = (input: {
  team: TeamRow;
  owner: Pick<User, 'id' | 'name' | 'email' | 'createdAt' | 'plan'>;
  members: MemberRow[];
  callerId: string;
}): Team => {
  const seatsUsed = input.members.length;
  return {
    id: input.team.id,
    name: input.team.name,
    seatsUsed,
    seatLimit: seatLimitFor(input.owner.plan),
    members: [...input.members.map(toTeamMember), ownerMember(input.owner)],
    isOwner: input.owner.id === input.callerId,
  };
};
