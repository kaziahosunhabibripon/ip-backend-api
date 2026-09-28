import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';
import type {
  AcceptTeamInviteRequest,
  CreateTeamRequest,
  InviteTeamMemberRequest,
  RenameTeamRequest,
  Team,
  TeamMember,
  TeamMemberStatus,
  TeamRole,
} from '../../contracts';
import { MAX_NAME_LENGTH } from '../team-rules';

export class CreateTeamDto implements CreateTeamRequest {
  @ApiProperty({
    required: false,
    maxLength: MAX_NAME_LENGTH,
    description: `Defaults to "{your name}'s team".`,
  })
  @IsOptional()
  @MaxLength(MAX_NAME_LENGTH)
  @IsString()
  name?: string;
}

export class RenameTeamDto implements RenameTeamRequest {
  @ApiProperty({ maxLength: MAX_NAME_LENGTH })
  @MaxLength(MAX_NAME_LENGTH)
  @IsString()
  name: string;
}

export class InviteTeamMemberDto implements InviteTeamMemberRequest {
  @ApiProperty({
    example: 'teammate@company.com',
    description:
      'Must belong to an existing IPScope account — invites are not held for an email that has never signed up.',
  })
  @MaxLength(254)
  @IsEmail()
  email: string;
}

export class AcceptTeamInviteDto implements AcceptTeamInviteRequest {
  @ApiProperty({ description: 'The token from the invitation email.' })
  @IsString()
  token: string;
}

const ROLES: TeamRole[] = ['owner', 'member'];
const STATUSES: TeamMemberStatus[] = ['invited', 'active'];

export class TeamMemberDto implements TeamMember {
  @ApiProperty({
    description:
      "The owner's row uses their user id; every other row is its own membership id — what DELETE /team/members/{id} takes.",
  })
  id: string;

  @ApiProperty() name: string;
  @ApiProperty() email: string;
  @ApiProperty({ enum: ROLES }) role: TeamRole;
  @ApiProperty({ enum: STATUSES }) status: TeamMemberStatus;
  @ApiProperty({ format: 'date-time' }) invitedAt: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  joinedAt: string | null;
}

export class TeamDto implements Team {
  @ApiProperty() id: string;
  @ApiProperty() name: string;

  @ApiProperty({
    description: 'Invited and active members, the owner not counted.',
  })
  seatsUsed: number;

  @ApiProperty({ nullable: true, type: Number })
  seatLimit: number | null;

  @ApiProperty({
    type: [TeamMemberDto],
    description: "Newest first; the owner's row is always last.",
  })
  members: TeamMemberDto[];

  @ApiProperty({
    description:
      'True when the caller owns this team. Every mutating route re-checks this on the server regardless of what the UI shows.',
  })
  isOwner: boolean;
}
