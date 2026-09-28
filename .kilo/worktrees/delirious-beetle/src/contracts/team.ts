// --------------------------------------------------------------- team workspace

export type TeamRole = "owner" | "member";
export type TeamMemberStatus = "invited" | "active";

/**
 * One row of the roster — the owner included, as a synthesized entry (`role: "owner"`, always `"active"`).
 * `name`/`email` are always known: an invite targets an existing IPScope account, never a bare address.
 */
export interface TeamMember {
  /** The owner's synthesized row uses their user id; every other row is its own `team_members` id — what `DELETE /team/members/{id}` takes. */
  id: string;
  name: string;
  email: string;
  role: TeamRole;
  status: TeamMemberStatus;
  invitedAt: string;
  /** Null while still `invited`. */
  joinedAt: string | null;
}

export interface Team {
  id: string;
  name: string;
  /** Seats used — invited and active members, the owner not counted. */
  seatsUsed: number;
  /** From the owner's plan; null when negotiated (Enterprise). */
  seatLimit: number | null;
  /** Newest first, the owner's row always last. */
  members: TeamMember[];
  /** True when the caller owns this team. The API enforces this independently of what the UI shows. */
  isOwner: boolean;
}

export interface CreateTeamRequest {
  /** Defaults to "{name}'s team" when left out. */
  name?: string;
}

export interface RenameTeamRequest {
  name: string;
}

export interface InviteTeamMemberRequest {
  email: string;
}

export interface AcceptTeamInviteRequest {
  token: string;
}
