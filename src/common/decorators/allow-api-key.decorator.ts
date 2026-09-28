import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { ApiKeyRateLimitGuard } from '../guards/api-key-rate-limit.guard';

export const ALLOWS_API_KEY = 'allowsApiKey';

/**
 * Marks a route that API keys may authenticate (`Authorization: Bearer ips_live_…`). Everywhere else a
 * key is ignored and the session cookie is required as before, so a key can only ever do what the public
 * API offers — never manage the account, keys, billing or history. Also attaches the per-key rate limit.
 */
export const AllowApiKey = () =>
  applyDecorators(
    SetMetadata(ALLOWS_API_KEY, true),
    UseGuards(ApiKeyRateLimitGuard),
  );
