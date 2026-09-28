import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { ApiKeyPrincipal } from '../api-keys/api-key-auth.service';
import { AllowApiKey } from '../common/decorators/allow-api-key.decorator';
import { ApiErrorResponses } from '../common/decorators/api-error-responses.decorator';
import {
  CurrentApiKey,
  CurrentUser,
  RequiredUser,
} from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { IpThrottlerGuard } from '../common/guards/ip-throttler.guard';
import type { CheckResponse, User } from '../contracts';
import { CheckRequestDto } from './dto/check-request.dto';
import { CheckResponseDto } from './dto/check-response.dto';
import { LookupService } from './lookup.service';

@ApiTags('lookup')
@Controller('check')
@UseGuards(IpThrottlerGuard)
export class LookupController {
  constructor(private readonly lookup: LookupService) {}

  @Public()
  @AllowApiKey()
  @Post()
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiCookieAuth()
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Analyze a domain or IP address',
    description: [
      'Works signed out (2 lookups a day per network), signed in (monthly quota by plan) and with an API key.',
      '',
      '**API keys.** Send `Authorization: Bearer ips_live_…` (Pro and above; create keys under `/api-keys`). A request made with a key counts against the plan’s monthly API allowance — every request, cache hits included; one that gets nothing back is refunded — is not saved to the account’s history, and is limited per key (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` on every response; `429 RATE_LIMITED` with `Retry-After` and `details.retryAfterSeconds` when exceeded). `quota` in the response then describes the API allowance. A missing, unknown or revoked key is `401`, never a fallback to anonymous.',
      '',
      '**Partial results.** DNS, geolocation, network ownership and security are gathered independently; each section reports its own `status` (`ok`, `unavailable`, `timeout`), and the check `status` is `partial` when any of them failed.',
      '',
      '**Entitlements.** Premium fields (MX/NS/TXT/SOA, reverse DNS, detailed security) come back as `{ "access": "locked", "requiredPlan": "pro" }` for callers without the plan — the values are never sent.',
      '',
      '**Caching.** A repeat of a recent lookup is served from cache (`cache.hit: true`) and does not use quota. `refresh: true` forces a fresh run.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: CheckResponseDto })
  @ApiErrorResponses(401, 403, 422, 429, 503)
  check(
    @Body() dto: CheckRequestDto,
    @CurrentUser() user: User | undefined,
    @CurrentApiKey() apiKey: ApiKeyPrincipal | undefined,
    @Req() request: Request,
  ): Promise<CheckResponse> {
    return this.lookup.check(
      dto.target,
      { user: user ?? null, ip: request.ip, apiKey },
      dto.refresh ?? false,
    );
  }

  @Get(':id')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Reopen a saved check',
    description:
      'Returns a check from the caller’s own history without spending a lookup. Entitlements are re-applied against the caller’s current plan.',
  })
  @ApiOkResponse({ type: CheckResponseDto })
  @ApiErrorResponses(401, 404)
  getSaved(
    @RequiredUser() user: User,
    @Param('id') id: string,
  ): Promise<CheckResponse> {
    return this.lookup.getSaved(id, user);
  }
}
