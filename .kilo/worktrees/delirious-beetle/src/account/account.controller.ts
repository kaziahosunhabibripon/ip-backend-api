import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Res,
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
import type { Response } from 'express';
import { clearSessionCookie } from '../auth/session-cookie';
import { ApiErrorResponses } from '../common/decorators/api-error-responses.decorator';
import {
  CurrentSessionId,
  RequiredUser,
} from '../common/decorators/current-user.decorator';
import { UserDto } from '../common/dto/user.dto';
import type { NotificationPreferences, SessionInfo, User } from '../contracts';
import { AccountService } from './account.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import {
  NotificationPreferencesDto,
  UpdateNotificationsDto,
} from './dto/notification-preferences.dto';
import { SessionInfoDto } from './dto/session-info.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

@ApiTags('account')
@ApiCookieAuth()
@Controller('account')
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Patch('profile')
  @ApiOperation({ summary: 'Update name and email' })
  @ApiOkResponse({ type: UserDto })
  @ApiErrorResponses(401, 409, 422)
  updateProfile(
    @RequiredUser() user: User,
    @Body() dto: UpdateProfileDto,
  ): Promise<User> {
    return this.account.updateProfile(user, dto);
  }

  @Post('password')
  @HttpCode(204)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Change password',
    description:
      'Signs out every other device; the current session stays logged in.',
  })
  @ApiNoContentResponse()
  @ApiErrorResponses(401, 422, 429)
  changePassword(
    @RequiredUser() user: User,
    @CurrentSessionId() sessionId: string | undefined,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    return this.account.changePassword(user, sessionId, dto);
  }

  @Get('notifications')
  @ApiOperation({ summary: 'Get notification preferences' })
  @ApiOkResponse({ type: NotificationPreferencesDto })
  @ApiErrorResponses(401)
  getNotifications(
    @RequiredUser() user: User,
  ): Promise<NotificationPreferences> {
    return this.account.getNotifications(user.id);
  }

  @Patch('notifications')
  @ApiOperation({
    summary: 'Update notification preferences',
    description: 'Send only the switches that changed.',
  })
  @ApiOkResponse({ type: NotificationPreferencesDto })
  @ApiErrorResponses(401, 422)
  updateNotifications(
    @RequiredUser() user: User,
    @Body() dto: UpdateNotificationsDto,
  ): Promise<NotificationPreferences> {
    return this.account.updateNotifications(user.id, dto);
  }

  @Get('sessions')
  @ApiOperation({ summary: 'List active sessions, most recent first' })
  @ApiOkResponse({ type: [SessionInfoDto] })
  @ApiErrorResponses(401)
  listSessions(
    @RequiredUser() user: User,
    @CurrentSessionId() sessionId: string | undefined,
  ): Promise<SessionInfo[]> {
    return this.account.listSessions(user.id, sessionId);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Sign out one session',
    description:
      'Revoking the current session also clears this browser’s cookie.',
  })
  @ApiNoContentResponse()
  @ApiErrorResponses(401, 404)
  async revokeSession(
    @RequiredUser() user: User,
    @CurrentSessionId() currentSessionId: string | undefined,
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.account.revokeSession(user.id, id);
    if (id === currentSessionId) {
      clearSessionCookie(response);
    }
  }

  @Delete()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete the account',
    description:
      'Permanently removes the user and everything they own (history, monitors, API keys, subscription). Cannot be undone.',
  })
  @ApiNoContentResponse()
  @ApiErrorResponses(401)
  async deleteAccount(
    @RequiredUser() user: User,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.account.deleteAccount(user.id);
    clearSessionCookie(response);
  }
}
