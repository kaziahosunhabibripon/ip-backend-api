import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
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
import { SkipThrottle, Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ApiErrorResponses } from '../common/decorators/api-error-responses.decorator';
import {
  CurrentUser,
  RequiredUser,
} from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { buildQuotaSnapshot } from '../common/quota';
import type { User } from '../contracts';
import { UsageService } from '../usage/usage.service';
import { AuthService } from './auth.service';
import { AuthUserPayloadDto, SessionPayloadDto } from './dto/auth-payloads.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyEmailQueryDto } from './dto/verify-email-query.dto';
import { getRequestMeta } from './request-meta';
import {
  clearSessionCookie,
  SESSION_COOKIE_NAME,
  setSessionCookie,
} from './session-cookie';

@ApiTags('auth')
@Controller('auth')
@UseGuards(ThrottlerGuard)
@Throttle({ default: { limit: 10, ttl: 60_000 } })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly usage: UsageService,
  ) {}

  @Public()
  @Post('register')
  @ApiOperation({
    summary: 'Create an account',
    description:
      'Signs the new user in (sets the `ipscope_session` cookie) and emails a verification link.',
  })
  @ApiCreatedResponse({ type: AuthUserPayloadDto })
  @ApiErrorResponses(409, 422, 429)
  async register(
    @Body() dto: RegisterDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthUserPayloadDto> {
    const session = await this.auth.register(dto, getRequestMeta(request));
    setSessionCookie(response, session.token);
    return { user: session.user };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Log in',
    description: 'Sets the `ipscope_session` cookie (HttpOnly, SameSite=Lax).',
  })
  @ApiOkResponse({ type: AuthUserPayloadDto })
  @ApiErrorResponses(401, 422, 429)
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthUserPayloadDto> {
    const session = await this.auth.login(dto, getRequestMeta(request));
    setSessionCookie(
      response,
      session.token,
      session.persistent ? session.expiresAt : undefined,
    );
    return { user: session.user };
  }

  @Public()
  @SkipThrottle()
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Log out',
    description:
      'Ends the current session and clears the cookie. Succeeds even if there is no session.',
  })
  @ApiNoContentResponse()
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const cookies = request.cookies as
      Record<string, string | undefined> | undefined;
    await this.auth.logout(cookies?.[SESSION_COOKIE_NAME]);
    clearSessionCookie(response);
  }

  @Public()
  @SkipThrottle()
  @Get('me')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Current viewer and lookup quota',
    description:
      'Never fails for signed-out visitors — `user` is null and `quota` is the anonymous daily quota.',
  })
  @ApiOkResponse({ type: SessionPayloadDto })
  async me(
    @CurrentUser() user: User | undefined,
    @Req() request: Request,
  ): Promise<SessionPayloadDto> {
    const viewer = user ?? null;
    const used = await this.usage.getUsed(
      this.usage.scopeFor(viewer, request.ip),
    );
    return { user: viewer, quota: buildQuotaSnapshot(viewer, used) };
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Email a password-reset link',
    description:
      'Always responds 204, whether or not the address is registered, so it cannot be used to discover accounts. The link is valid for 1 hour.',
  })
  @ApiNoContentResponse()
  @ApiErrorResponses(422, 429)
  forgotPassword(@Body() dto: ForgotPasswordDto): Promise<void> {
    return this.auth.requestPasswordReset(dto);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Set a new password from an emailed token',
    description:
      'The token works once. On success every existing session for the account is signed out.',
  })
  @ApiNoContentResponse()
  @ApiErrorResponses(422, 429)
  resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    return this.auth.resetPassword(dto);
  }

  @Post('resend-verification')
  @HttpCode(204)
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Resend the email-verification link',
    description:
      'Does nothing if the address is already verified. Invalidates any earlier link.',
  })
  @ApiNoContentResponse()
  @ApiErrorResponses(401, 429)
  resendVerification(@RequiredUser() user: User): Promise<void> {
    return this.auth.resendVerification(user.id);
  }

  @Public()
  @Get('verify-email')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Confirm an email address',
    description:
      'Called by the ipscope-web `/verify-email` page with the token from the emailed link. The token works once and expires after 24 hours.',
  })
  @ApiNoContentResponse()
  @ApiErrorResponses(422, 429)
  verifyEmail(@Query() query: VerifyEmailQueryDto): Promise<void> {
    return this.auth.verifyEmail(query.token);
  }
}
