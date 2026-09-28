import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorResponses } from '../common/decorators/api-error-responses.decorator';
import { RequiredUser } from '../common/decorators/current-user.decorator';
import { RequiresPlan } from '../common/decorators/requires-plan.decorator';
import { requiredPlan } from '../common/features';
import type { Alert, User } from '../contracts';
import { AlertsService } from './alerts.service';
import { AlertDto, SetAlertReadDto } from './dto/alerts.dto';

@ApiTags('alerts')
@ApiCookieAuth()
@Controller('alerts')
@RequiresPlan(requiredPlan('alerts'))
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  @ApiOperation({
    summary: 'The alert inbox, newest first',
    description:
      'Changes and failures found by the caller’s monitors. Returns up to the latest 500; the site filters by category, severity and unread in the browser. Needs the Pro plan or higher.',
  })
  @ApiOkResponse({ type: [AlertDto] })
  @ApiErrorResponses(401, 403)
  list(@RequiredUser() user: User): Promise<Alert[]> {
    return this.alerts.list(user.id);
  }

  @Post('read-all')
  @HttpCode(204)
  @ApiOperation({ summary: 'Mark every alert as read' })
  @ApiNoContentResponse()
  @ApiErrorResponses(401, 403)
  markAllRead(@RequiredUser() user: User): Promise<void> {
    return this.alerts.markAllRead(user.id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Mark one alert read or unread' })
  @ApiOkResponse({ type: AlertDto })
  @ApiErrorResponses(401, 403, 404, 422)
  setRead(
    @RequiredUser() user: User,
    @Param('id') id: string,
    @Body() dto: SetAlertReadDto,
  ): Promise<Alert> {
    return this.alerts.setRead(user.id, id, dto.read);
  }
}
