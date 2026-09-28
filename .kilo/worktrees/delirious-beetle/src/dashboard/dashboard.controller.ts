import { Controller, Get } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorResponses } from '../common/decorators/api-error-responses.decorator';
import { RequiredUser } from '../common/decorators/current-user.decorator';
import type { DashboardSummary, User } from '../contracts';
import { AlertDto } from '../alerts/dto/alerts.dto';
import { CheckHistoryDto } from '../history/dto/history.dto';
import { DashboardService } from './dashboard.service';

class DashboardSummaryDto {
  @ApiProperty({
    type: [CheckHistoryDto],
    description: 'The five most recent saved checks.',
  })
  recentChecks: CheckHistoryDto[];

  @ApiProperty({
    type: [AlertDto],
    description:
      'The four newest alerts. Empty below the Pro plan, which has no alerts.',
  })
  recentAlerts: AlertDto[];

  @ApiProperty({
    description: 'Monitors that are not paused. 0 below the Pro plan.',
  })
  activeMonitors: number;

  @ApiProperty({ description: 'Unread alerts. 0 below the Pro plan.' })
  unreadAlerts: number;
}

@ApiTags('dashboard')
@ApiCookieAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @ApiOperation({ summary: 'Everything the dashboard shows, in one request' })
  @ApiOkResponse({ type: DashboardSummaryDto })
  @ApiErrorResponses(401)
  summary(@RequiredUser() user: User): Promise<DashboardSummary> {
    return this.dashboard.summary(user);
  }
}
