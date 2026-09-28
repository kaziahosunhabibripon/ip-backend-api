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
import { RequiresPlan } from '../common/decorators/requires-plan.decorator';
import { requiredPlan } from '../common/features';
import type { ApiUsageSummary, User } from '../contracts';
import { ApiUsageService } from './api-usage.service';

class ApiUsagePointDto {
  @ApiProperty({ example: '2026-09-24', description: 'UTC day.' })
  date: string;

  @ApiProperty() requests: number;

  @ApiProperty({ description: 'Requests that ended with nothing readable.' })
  errors: number;
}

class ApiUsageSummaryDto implements ApiUsageSummary {
  @ApiProperty({ description: 'Since 00:00 UTC.' })
  requestsToday: number;

  @ApiProperty({ description: 'Since the 1st of this month, UTC. Exact.' })
  requestsMonth: number;

  @ApiProperty({ description: 'The plan’s API requests a month.' })
  monthlyLimit: number;

  @ApiProperty()
  remaining: number;

  @ApiProperty({ description: '0–1, over the last 30 days.' })
  errorRate: number;

  @ApiProperty({ description: 'What a production key of this plan may send.' })
  rateLimitPerMinute: number;

  @ApiProperty({
    type: [ApiUsagePointDto],
    description: 'The last 30 UTC days, oldest first, zeros included.',
  })
  series: ApiUsagePointDto[];
}

@ApiTags('api-usage')
@ApiCookieAuth()
@Controller('api-usage')
@RequiresPlan(requiredPlan('apiAccess'))
export class ApiUsageController {
  constructor(private readonly apiUsage: ApiUsageService) {}

  @Get()
  @ApiOperation({
    summary: 'API traffic for the API dashboard',
    description:
      'Requests made with the caller’s API keys against the plan’s monthly allowance. Needs the Pro plan or higher.',
  })
  @ApiOkResponse({ type: ApiUsageSummaryDto })
  @ApiErrorResponses(401, 403)
  summary(@RequiredUser() user: User): Promise<ApiUsageSummary> {
    return this.apiUsage.summary(user);
  }
}
