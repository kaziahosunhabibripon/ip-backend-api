import { Injectable, Logger } from '@nestjs/common';
import { ApiException } from '../common/dto/api-exception';
import type { Plan, Team, User } from '../contracts';
import { AuthTokenService } from '../auth/auth-token.service';
import { TeamMailService } from './team-mail.service';
import {
  INVITE_TTL_MS,
  MAX_NAME_LENGTH,
  defaultTeamName,
  resolveEffectivePlan,
  seatLimitFor,
  toTeam,
} from './team-rules';
import { TeamsStore } from './teams-store.service';

/** How long an entry from `findActiveOwnerPlan` is trusted before asking the database again. */
const PLAN_CACHE_MS = 15_000;

@Injectable()
export class TeamsService {
  private readonly logger = new Logger(TeamsService.name);
  private readonly ownerPlanCache = new Map<
    string,
    { plan: Plan | null; until: number }
  >();

  constructor(
    private readonly store: TeamsStore,
    private readonly tokens: AuthTokenService,
    private readonly mail: TeamMailService,
  ) {}

  /**
   * `user.plan`, or the plan of the team `user` is an *active* member of, if that is higher — never lower,
   * and never for the team's own owner (an owner's access always comes from their own plan). Cached briefly
   * per account; a change (accepting, leaving, being removed) invalidates that account's entry immediately,
   * the owner's own plan changing elsewhere reaches members within `PLAN_CACHE_MS`.
   */
  async effectivePlan(user: Pick<User, 'id' | 'plan'>): Promise<Plan> {
    const cached = this.ownerPlanCache.get(user.id);
    const now = Date.now();
    if (cached && cached.until > now) {
      return resolveEffectivePlan(user.plan, cached.plan);
    }

    try {
      const ownerPlan = await this.store.findActiveOwnerPlan(user.id);
      this.ownerPlanCache.set(user.id, {
        plan: ownerPlan,
        until: now + PLAN_CACHE_MS,
      });
      return resolveEffectivePlan(user.plan, ownerPlan);
    } catch (error) {
      this.logger.warn(
        `Could not resolve team membership, using the account's own plan: ${error instanceof Error ? error.message : String(error)}`,
      );
      return user.plan;
    }
  }

  private forget(userId: string) {
    this.ownerPlanCache.delete(userId);
  }

  async myTeam(caller: User): Promise<Team | null> {
    const owned = await this.store.findByOwnerId(caller.id);
    if (owned) {
      return this.view(owned, caller, caller.id);
    }

    const membership = await this.store.findMembershipTeam(caller.id);
    if (!membership) {
      return null;
    }
    const owner = await this.store.ownerUser(membership.ownerId);
    if (!owner) {
      return null;
    }
    return this.view(membership.team, owner, caller.id);
  }

  private async view(
    team: { id: string; name: string },
    owner: User,
    callerId: string,
  ): Promise<Team> {
    const members = await this.store.listMembers(team.id);
    return toTeam({ team, owner, members, callerId });
  }

  async create(caller: User, name: string | undefined): Promise<Team> {
    if (await this.store.findByOwnerId(caller.id)) {
      throw new ApiException('CONFLICT', 'You already have a team.');
    }
    if (await this.store.findMembershipTeam(caller.id)) {
      throw new ApiException(
        'CONFLICT',
        "You're already a member of someone else's team. Leave it before starting your own.",
      );
    }

    const team = await this.store.createTeam(
      caller.id,
      (name?.trim() || defaultTeamName(caller.name)).slice(0, MAX_NAME_LENGTH),
    );
    return this.view(team, caller, caller.id);
  }

  async rename(caller: User, name: string): Promise<Team> {
    const team = await this.ownedTeamOrThrow(caller.id);
    const trimmed = name.trim();
    if (!trimmed) {
      throw new ApiException('INVALID_INPUT', 'Give the team a name.');
    }
    await this.store.renameTeam(team.id, trimmed.slice(0, MAX_NAME_LENGTH));
    return this.view({ ...team, name: trimmed }, caller, caller.id);
  }

  async remove(caller: User): Promise<void> {
    const team = await this.ownedTeamOrThrow(caller.id);
    const members = await this.store.listMembers(team.id);
    await this.store.deleteTeam(team.id);
    for (const member of members) {
      this.forget(member.user.id);
      void this.mail.notifyRemoved({
        to: member.user.email,
        name: member.user.name,
        teamName: team.name,
      });
    }
  }

  async invite(caller: User, email: string): Promise<Team> {
    const team = await this.ownedTeamOrThrow(caller.id);
    const normalized = email.trim().toLowerCase();

    const invitee = await this.store.userByEmail(normalized);
    if (!invitee) {
      throw new ApiException(
        'INVALID_INPUT',
        'No IPScope account uses that email. Ask them to sign up first, then invite them.',
        { field: 'email' },
      );
    }
    if (invitee.id === caller.id) {
      throw new ApiException('INVALID_INPUT', "That's your own account.");
    }
    if (await this.store.findByOwnerId(invitee.id)) {
      throw new ApiException(
        'CONFLICT',
        'That account already owns its own team.',
      );
    }
    const existingMembership = await this.store.findMembershipTeam(invitee.id);
    if (existingMembership?.team.id === team.id) {
      throw new ApiException(
        'CONFLICT',
        'They already have an invitation to this team.',
      );
    }
    if (existingMembership) {
      throw new ApiException(
        'CONFLICT',
        "That account is already on someone else's team.",
      );
    }

    const seatLimit = seatLimitFor(caller.plan);
    if (seatLimit !== null) {
      const used = (await this.store.listMembers(team.id)).length;
      if (used >= seatLimit) {
        throw new ApiException(
          'CONFLICT',
          `Your plan includes ${seatLimit} team seats and they're all used. Remove someone or upgrade to invite another.`,
          { limit: seatLimit },
        );
      }
    }

    await this.store.inviteMember(team.id, invitee.id);
    const token = await this.tokens.issue(
      invitee.id,
      'team_invite',
      INVITE_TTL_MS,
    );
    void this.mail.sendInvite({
      to: invitee.email,
      inviteeName: invitee.name,
      ownerName: caller.name,
      teamName: team.name,
      token,
    });

    return this.view(team, caller, caller.id);
  }

  async removeMember(caller: User, memberId: string): Promise<void> {
    const team = await this.ownedTeamOrThrow(caller.id);
    const member = await this.store.findMemberById(memberId);
    if (!member || member.teamId !== team.id) {
      throw new ApiException('NOT_FOUND', 'That member was not found.');
    }
    const removed = await this.store.userById(member.userId);
    await this.store.removeMember(memberId);
    this.forget(member.userId);
    if (removed) {
      void this.mail.notifyRemoved({
        to: removed.email,
        name: removed.name,
        teamName: team.name,
      });
    }
  }

  /** The caller leaves whatever team they're a member of. A no-op error for an owner — they delete the team instead. */
  async leave(caller: User): Promise<void> {
    if (await this.store.findByOwnerId(caller.id)) {
      throw new ApiException(
        'CONFLICT',
        'You own this team — delete it instead of leaving.',
      );
    }
    const left = await this.store.removeMemberByUserId(caller.id);
    if (!left) {
      throw new ApiException('NOT_FOUND', "You're not on a team.");
    }
    this.forget(caller.id);
  }

  async accept(caller: User, token: string): Promise<Team> {
    // Checked, not consumed, first: a wrong guess — or the right token typed in as the wrong signed-in
    // account — must not burn someone else's one-use invite.
    const invited = await this.tokens.verify(token, 'team_invite');
    if (!invited || invited !== caller.id) {
      throw new ApiException(
        'INVALID_INPUT',
        'That invitation link is invalid or has expired.',
      );
    }

    const membership = await this.store.findMembershipTeam(caller.id);
    if (!membership) {
      throw new ApiException(
        'INVALID_INPUT',
        'That invitation link is invalid or has expired.',
      );
    }

    const userId = await this.tokens.consume(token, 'team_invite');
    if (!userId) {
      // Raced with another accept of the very same link between the check above and here.
      throw new ApiException(
        'INVALID_INPUT',
        'That invitation link is invalid or has expired.',
      );
    }

    await this.store.activate(membership.membershipId, new Date());
    this.forget(caller.id);

    const owner = await this.store.ownerUser(membership.ownerId);
    if (!owner) {
      throw new ApiException('NOT_FOUND', 'That team no longer exists.');
    }
    return this.view(membership.team, owner, caller.id);
  }

  private async ownedTeamOrThrow(ownerId: string) {
    const team = await this.store.findByOwnerId(ownerId);
    if (!team) {
      throw new ApiException(
        'NOT_FOUND',
        "You don't have a team yet. Create one first.",
      );
    }
    return team;
  }
}
