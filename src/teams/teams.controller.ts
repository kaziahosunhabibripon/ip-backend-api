import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ApiErrorResponses } from '../common/decorators/api-error-responses.decorator';
import { RequiredUser } from '../common/decorators/current-user.decorator';
import { RequiresPlan } from '../common/decorators/requires-plan.decorator';
import { requiredPlan } from '../common/features';
import type { Team, User } from '../contracts';
import {
  AcceptTeamInviteDto,
  CreateTeamDto,
  InviteTeamMemberDto,
  RenameTeamDto,
  TeamDto,
} from './dto/team.dto';
import { TeamsService } from './teams.service';

@ApiTags('team')
@ApiCookieAuth()
@Controller('team')
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  @ApiOperation({
    summary: 'The caller’s team',
    description:
      'Whether the caller owns a team or is a member (invited or active) of one — the same roster shape either way, minus what only the owner is allowed to change. `null` when the caller has neither.',
  })
  @ApiOkResponse({ type: TeamDto })
  @ApiErrorResponses(401)
  get(@RequiredUser() user: User): Promise<Team | null> {
    return this.teams.myTeam(user);
  }

  @Post()
  @RequiresPlan(requiredPlan('teams'))
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Start a team',
    description:
      'Needs the Business plan or higher. 409 CONFLICT if the caller already owns a team, or is already a member of someone else’s.',
  })
  @ApiOkResponse({ type: TeamDto })
  @ApiErrorResponses(401, 403, 409, 422, 429)
  create(
    @RequiredUser() user: User,
    @Body() dto: CreateTeamDto,
  ): Promise<Team> {
    return this.teams.create(user, dto.name);
  }

  @Patch()
  @ApiOperation({ summary: 'Rename the team the caller owns' })
  @ApiOkResponse({ type: TeamDto })
  @ApiErrorResponses(401, 404, 422)
  rename(
    @RequiredUser() user: User,
    @Body() dto: RenameTeamDto,
  ): Promise<Team> {
    return this.teams.rename(user, dto.name);
  }

  @Delete()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete the team the caller owns',
    description:
      'Removes every membership too. Members go back to their own plan at once, and are emailed to say so.',
  })
  @ApiNoContentResponse()
  @ApiErrorResponses(401, 404)
  remove(@RequiredUser() user: User): Promise<void> {
    return this.teams.remove(user);
  }

  @Post('invite')
  @RequiresPlan(requiredPlan('teams'))
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Invite a member',
    description:
      'The address must belong to an existing IPScope account. Sends an emailed link; the invite counts against the seat limit (Business: 10, Enterprise: negotiated) from the moment it is sent, accepted or not. 409 CONFLICT past the limit, or if that account already owns a team or belongs to another one.',
  })
  @ApiOkResponse({ type: TeamDto })
  @ApiErrorResponses(401, 403, 404, 409, 422, 429)
  invite(
    @RequiredUser() user: User,
    @Body() dto: InviteTeamMemberDto,
  ): Promise<Team> {
    return this.teams.invite(user, dto.email);
  }

  @Delete('members/:id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove a member, or cancel a pending invite',
    description:
      'Removes their access to the team’s plan immediately, and emails them to say so.',
  })
  @ApiNoContentResponse()
  @ApiErrorResponses(401, 404)
  removeMember(
    @RequiredUser() user: User,
    @Param('id') id: string,
  ): Promise<void> {
    return this.teams.removeMember(user, id);
  }

  @Post('leave')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Leave the team the caller is a member of',
    description:
      'Not for an owner — delete the team instead. 404 if the caller is not on a team.',
  })
  @ApiNoContentResponse()
  @ApiErrorResponses(401, 404, 409)
  leave(@RequiredUser() user: User): Promise<void> {
    return this.teams.leave(user);
  }

  @Post('accept')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Accept an invitation',
    description:
      'The token from the invitation email. Must be signed in as the invited account — the invitation was addressed to one account and only that account can accept it.',
  })
  @ApiOkResponse({ type: TeamDto })
  @ApiErrorResponses(401, 422)
  accept(
    @RequiredUser() user: User,
    @Body() dto: AcceptTeamInviteDto,
  ): Promise<Team> {
    return this.teams.accept(user, dto.token);
  }
}
