import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
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
import type { ApiKey, CreatedApiKey, User } from '../contracts';
import { ApiKeysService } from './api-keys.service';
import {
  ApiKeyDto,
  CreateApiKeyDto,
  CreatedApiKeyDto,
} from './dto/api-keys.dto';

/**
 * Managing keys is a signed-in, cookie-authenticated job: a key can never create, list or revoke keys,
 * so a leaked key can be revoked by its owner but can't be used to mint replacements.
 */
@ApiTags('api-keys')
@ApiCookieAuth()
@Controller('api-keys')
@RequiresPlan(requiredPlan('apiAccess'))
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  @ApiOperation({
    summary: 'The caller’s API keys, newest first',
    description:
      'Never includes a secret. Needs the Pro plan or higher; lower plans get 403 PLAN_REQUIRED.',
  })
  @ApiOkResponse({ type: [ApiKeyDto] })
  @ApiErrorResponses(401, 403)
  list(@RequiredUser() user: User): Promise<ApiKey[]> {
    return this.keys.list(user);
  }

  @Post()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Create an API key',
    description:
      'The response carries the full secret **once**. It is not stored (only a hash is) and cannot be shown again: if it is lost, revoke the key and create another. An account can hold up to 25 keys.',
  })
  @ApiCreatedResponse({ type: CreatedApiKeyDto })
  @ApiErrorResponses(401, 403, 409, 422, 429)
  create(
    @RequiredUser() user: User,
    @Body() dto: CreateApiKeyDto,
  ): Promise<CreatedApiKey> {
    return this.keys.create(user, dto);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Revoke a key',
    description:
      'The key stops working on its very next request, and stays in the list marked revoked. Revoking twice is harmless.',
  })
  @ApiOkResponse({ type: ApiKeyDto })
  @ApiErrorResponses(401, 403, 404)
  revoke(@RequiredUser() user: User, @Param('id') id: string): Promise<ApiKey> {
    return this.keys.revoke(user, id);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete a key',
    description:
      'Removes it from the list. Stops working at once, like a revoked key.',
  })
  @ApiNoContentResponse()
  @ApiErrorResponses(401, 403, 404)
  remove(@RequiredUser() user: User, @Param('id') id: string): Promise<void> {
    return this.keys.remove(user, id);
  }
}
