import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, isNull } from 'drizzle-orm';
import type { Plan } from '../contracts';
import type { Database } from '../db/database';
import { teamMembers, teams, users } from '../db/schema';
import { toUser, type UserRow } from '../users/user.mapper';
import type { MemberRow, TeamRow } from './team-rules';

export interface OwnedTeam {
  team: TeamRow;
  ownerId: string;
}

@Injectable()
export class TeamsStore {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  async findByOwnerId(ownerId: string): Promise<TeamRow | null> {
    const [row] = await this.db
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(eq(teams.ownerId, ownerId));
    return row ?? null;
  }

  /** The team a user belongs to as a member (invited or active) — never the one they own. */
  async findMembershipTeam(
    userId: string,
  ): Promise<{ team: TeamRow; ownerId: string; membershipId: string } | null> {
    const [row] = await this.db
      .select({
        team: { id: teams.id, name: teams.name },
        ownerId: teams.ownerId,
        membershipId: teamMembers.id,
      })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(eq(teamMembers.userId, userId));
    return row ?? null;
  }

  /**
   * The plan of the team a user is an ACTIVE member of, for `TeamsService.effectivePlan` — a suspended
   * owner's team doesn't elevate anyone, same as a suspended account can't do anything else either.
   */
  async findActiveOwnerPlan(userId: string): Promise<Plan | null> {
    const [row] = await this.db
      .select({ plan: users.plan })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .innerJoin(users, eq(users.id, teams.ownerId))
      .where(
        and(
          eq(teamMembers.userId, userId),
          eq(teamMembers.status, 'active'),
          isNull(users.suspendedAt),
        ),
      );
    return row?.plan ?? null;
  }

  async listMembers(teamId: string): Promise<MemberRow[]> {
    const rows = await this.db
      .select({
        id: teamMembers.id,
        status: teamMembers.status,
        invitedAt: teamMembers.invitedAt,
        joinedAt: teamMembers.joinedAt,
        user: { id: users.id, name: users.name, email: users.email },
      })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(eq(teamMembers.teamId, teamId))
      .orderBy(teamMembers.invitedAt);
    return rows;
  }

  async createTeam(ownerId: string, name: string): Promise<TeamRow> {
    const [row] = await this.db
      .insert(teams)
      .values({ ownerId, name })
      .returning({ id: teams.id, name: teams.name });
    return row;
  }

  async renameTeam(teamId: string, name: string): Promise<void> {
    await this.db.update(teams).set({ name }).where(eq(teams.id, teamId));
  }

  /** Cascades to every membership row. */
  async deleteTeam(teamId: string): Promise<void> {
    await this.db.delete(teams).where(eq(teams.id, teamId));
  }

  async inviteMember(teamId: string, userId: string): Promise<MemberRow> {
    const [row] = await this.db
      .insert(teamMembers)
      .values({ teamId, userId })
      .returning({
        id: teamMembers.id,
        status: teamMembers.status,
        invitedAt: teamMembers.invitedAt,
        joinedAt: teamMembers.joinedAt,
      });
    const owner = await this.userById(userId);
    return { ...row, user: owner! };
  }

  async findMemberById(
    id: string,
  ): Promise<{ id: string; teamId: string; userId: string } | null> {
    const [row] = await this.db
      .select({
        id: teamMembers.id,
        teamId: teamMembers.teamId,
        userId: teamMembers.userId,
      })
      .from(teamMembers)
      .where(eq(teamMembers.id, id));
    return row ?? null;
  }

  async removeMember(id: string): Promise<void> {
    await this.db.delete(teamMembers).where(eq(teamMembers.id, id));
  }

  async removeMemberByUserId(userId: string): Promise<boolean> {
    const removed = await this.db
      .delete(teamMembers)
      .where(eq(teamMembers.userId, userId))
      .returning({ id: teamMembers.id });
    return removed.length > 0;
  }

  async activate(id: string, now: Date): Promise<void> {
    await this.db
      .update(teamMembers)
      .set({ status: 'active', joinedAt: now })
      .where(eq(teamMembers.id, id));
  }

  async userById(id: string): Promise<UserRow | undefined> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id));
    return row;
  }

  async userByEmail(email: string): Promise<UserRow | undefined> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email));
    return row;
  }

  async ownerUser(ownerId: string) {
    const row = await this.userById(ownerId);
    return row ? toUser(row) : null;
  }
}
