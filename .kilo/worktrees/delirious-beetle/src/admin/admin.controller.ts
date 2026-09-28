import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ApiErrorResponses } from '../common/decorators/api-error-responses.decorator';
import { RequiredUser } from '../common/decorators/current-user.decorator';
import { AdminGuard } from '../common/guards/admin.guard';
import type {
  AbuseFlag,
  AdminOverview,
  AdminUser,
  AdminUsersPage,
  User,
} from '../contracts';
import { AbuseReviewService } from './abuse-review.service';
import { AdminOverviewService } from './admin-overview.service';
import { AdminUsersService } from './admin-users.service';
import {
  AbuseFlagDto,
  AdminOverviewDto,
  AdminUserDto,
  AdminUsersPageDto,
  ListAdminUsersQueryDto,
  SuspendUserDto,
} from './dto/admin.dto';

/**
 * Everything here needs a signed-in administrator (`role = 'admin'`, given with `npm run admin:grant`) and a
 * session cookie: an API key can never reach these routes, whoever owns it. Every change is written to the audit log.
 */
@ApiTags('admin')
@ApiCookieAuth()
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly overview: AdminOverviewService,
    private readonly users: AdminUsersService,
    private readonly review: AbuseReviewService,
  ) {}

  @Get('overview')
  @ApiOperation({
    summary: 'The admin dashboard',
    description: [
      'Platform totals, revenue, the plan mix, the last 30 days of lookups by source, the most recently active users, recent subscription events, provider and infrastructure health, and abuse flags — all computed from live data.',
      '',
      '- **Provider health** is measured from the last 15 minutes of real provider calls on this API instance (`calls` says how many). With several instances each shows its own traffic.',
      '- **Deltas** compare with the period before and are `0` when there is nothing to compare with.',
      '- **Signed-out lookups** come from the daily quota counters, so they exclude repeats served from the cache.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: AdminOverviewDto })
  @ApiErrorResponses(401, 403)
  getOverview(): Promise<AdminOverview> {
    return this.overview.build();
  }

  @Get('users')
  @ApiOperation({
    summary: 'Search users',
    description: 'Most recently active first. `total` counts every match.',
  })
  @ApiOkResponse({ type: AdminUsersPageDto })
  @ApiErrorResponses(401, 403, 422)
  listUsers(@Query() query: ListAdminUsersQueryDto): Promise<AdminUsersPage> {
    return this.users.list({
      q: query.q,
      status: query.status,
      limit: query.limit ?? 25,
      offset: query.offset ?? 0,
    });
  }

  @Post('users/:id/suspend')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Suspend a user',
    description:
      'Takes effect on their very next request: their sessions are deleted (so their cookies stop working), API keys answer `403 FORBIDDEN`, signing in is refused, and their monitors stop running. Their data is kept; billing is untouched. Administrators can’t be suspended (`409`). Repeating it is harmless.',
  })
  @ApiOkResponse({ type: AdminUserDto })
  @ApiErrorResponses(401, 403, 404, 409, 422, 429)
  suspend(
    @RequiredUser() admin: User,
    @Param('id') id: string,
    @Body() body: SuspendUserDto,
  ): Promise<AdminUser> {
    return this.users.suspend(admin, id, body.reason);
  }

  @Post('users/:id/reactivate')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Lift a suspension',
    description: 'They can sign in again straight away.',
  })
  @ApiOkResponse({ type: AdminUserDto })
  @ApiErrorResponses(401, 403, 404, 429)
  reactivate(
    @RequiredUser() admin: User,
    @Param('id') id: string,
  ): Promise<AdminUser> {
    return this.users.reactivate(admin, id);
  }

  @Post('abuse/:id/block')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Block what an abuse flag points at',
    description:
      'For real, not just on the flag: an **account** is suspended (see `POST /admin/users/:id/suspend`), an **API key** is revoked, a **network** is refused anonymous lookups (`403 FORBIDDEN`). Blocking an administrator’s account is refused (`409`).',
  })
  @ApiOkResponse({ type: AbuseFlagDto })
  @ApiErrorResponses(401, 403, 404, 409, 429)
  block(
    @RequiredUser() admin: User,
    @Param('id') id: string,
  ): Promise<AbuseFlag> {
    return this.review.decide(admin, id, 'block');
  }

  @Post('abuse/:id/dismiss')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Dismiss an abuse flag',
    description:
      'Marks it as reviewed and harmless. It comes back to `open` by itself only if the behaviour doubles. A blocked flag must be reopened first (`409`).',
  })
  @ApiOkResponse({ type: AbuseFlagDto })
  @ApiErrorResponses(401, 403, 404, 409, 429)
  dismiss(
    @RequiredUser() admin: User,
    @Param('id') id: string,
  ): Promise<AbuseFlag> {
    return this.review.decide(admin, id, 'dismiss');
  }

  @Post('abuse/:id/reopen')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Reopen an abuse flag',
    description:
      'Undoes a dismissal, or a block: the account is reactivated and the network unblocked. A revoked API key can’t be restored (`409`); its owner can create a new one.',
  })
  @ApiOkResponse({ type: AbuseFlagDto })
  @ApiErrorResponses(401, 403, 404, 409, 429)
  reopen(
    @RequiredUser() admin: User,
    @Param('id') id: string,
  ): Promise<AbuseFlag> {
    return this.review.decide(admin, id, 'reopen');
  }
}
