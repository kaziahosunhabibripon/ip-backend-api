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
  ApiCreatedResponse,
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
import type { MonitoringOverview, MonitoringRule, User } from '../contracts';
import {
  CreateMonitorDto,
  MonitoringOverviewDto,
  MonitoringRuleDto,
  SetMonitorEnabledDto,
} from './dto/monitoring.dto';
import { MonitoringService } from './monitoring.service';

@ApiTags('monitoring')
@ApiCookieAuth()
@Controller('monitoring')
@RequiresPlan(requiredPlan('monitoring'))
export class MonitoringController {
  constructor(private readonly monitoring: MonitoringService) {}

  @Get()
  @ApiOperation({
    summary: 'The caller’s monitors and the plan limit',
    description:
      'Newest first. Needs the Pro plan or higher; lower plans get 403 PLAN_REQUIRED.',
  })
  @ApiOkResponse({ type: MonitoringOverviewDto })
  @ApiErrorResponses(401, 403)
  list(@RequiredUser() user: User): Promise<MonitoringOverview> {
    return this.monitoring.list(user);
  }

  @Post()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Start monitoring a domain or IP',
    description:
      'Runs a first check straight away to record the baseline that later checks are compared with, so this can take a few seconds. 409 CONFLICT if the target is already monitored; 403 PLAN_REQUIRED at the plan’s monitor limit.',
  })
  @ApiCreatedResponse({ type: MonitoringRuleDto })
  @ApiErrorResponses(401, 403, 409, 422, 429)
  create(
    @RequiredUser() user: User,
    @Body() dto: CreateMonitorDto,
  ): Promise<MonitoringRule> {
    return this.monitoring.create(user, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Pause or resume a monitor',
    description:
      'Resuming makes it due immediately and keeps the last baseline, so a change that happened while it was paused is still reported.',
  })
  @ApiOkResponse({ type: MonitoringRuleDto })
  @ApiErrorResponses(401, 403, 404, 422)
  setEnabled(
    @RequiredUser() user: User,
    @Param('id') id: string,
    @Body() dto: SetMonitorEnabledDto,
  ): Promise<MonitoringRule> {
    return this.monitoring.setEnabled(user, id, dto.enabled);
  }

  @Post(':id/run')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Check a monitor now',
    description:
      'Runs the same check the schedule would and returns the monitor afterwards. A paused monitor answers 409 CONFLICT.',
  })
  @ApiOkResponse({ type: MonitoringRuleDto })
  @ApiErrorResponses(401, 403, 404, 409, 429)
  run(
    @RequiredUser() user: User,
    @Param('id') id: string,
  ): Promise<MonitoringRule> {
    return this.monitoring.runNow(user, id);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete a monitor',
    description: 'Its alerts stay in the inbox.',
  })
  @ApiNoContentResponse()
  @ApiErrorResponses(401, 403, 404)
  remove(@RequiredUser() user: User, @Param('id') id: string): Promise<void> {
    return this.monitoring.remove(user, id);
  }
}
