import { Controller, Get, Query, Req } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { ApiErrorResponses } from '../common/decorators/api-error-responses.decorator';
import {
  CurrentUser,
  RequiredUser,
} from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { RequiresPlan } from '../common/decorators/requires-plan.decorator';
import { QuotaDto } from '../common/dto/user.dto';
import { requiredPlan } from '../common/features';
import { buildQuotaSnapshot } from '../common/quota';
import type { QuotaSnapshot, Usage, UsageAnalytics, User } from '../contracts';
import {
  AnalyticsQueryDto,
  UsageAnalyticsDto,
  UsageDto,
} from './dto/usage.dto';
import { UsageEventsService } from './usage-events.service';
import { UsageService } from './usage.service';

@ApiTags('usage')
@Controller('usage')
@ApiCookieAuth()
export class UsageController {
  constructor(
    private readonly usage: UsageService,
    private readonly events: UsageEventsService,
  ) {}

  @Public()
  @Get('quota')
  @ApiOperation({
    summary: 'Remaining lookups for the current viewer',
    description:
      'Works signed out too: the anonymous daily quota, counted per network.',
  })
  @ApiOkResponse({ type: QuotaDto })
  async quota(
    @CurrentUser() user: User | undefined,
    @Req() request: Request,
  ): Promise<QuotaSnapshot> {
    const viewer = user ?? null;
    const used = await this.usage.getUsed(
      this.usage.scopeFor(viewer, request.ip),
    );
    return buildQuotaSnapshot(viewer, used);
  }

  @Get()
  @ApiOperation({ summary: 'Usage against the plan limits this period' })
  @ApiOkResponse({ type: UsageDto })
  @ApiErrorResponses(401)
  overview(@RequiredUser() user: User): Promise<Usage> {
    return this.usage.overview(user);
  }

  @Get('analytics')
  @RequiresPlan(requiredPlan('usageAnalytics'))
  @ApiOperation({
    summary: 'Usage analytics over 7, 30 or 90 days',
    description:
      'Needs the Pro plan or higher; lower plans get 403 PLAN_REQUIRED.',
  })
  @ApiOkResponse({ type: UsageAnalyticsDto })
  @ApiErrorResponses(401, 403, 422)
  analytics(
    @RequiredUser() user: User,
    @Query() query: AnalyticsQueryDto,
  ): Promise<UsageAnalytics> {
    return this.events.analytics(user.id, query.range ?? '30d');
  }
}
