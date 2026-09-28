import { Injectable } from '@nestjs/common';
import { ApiException } from '../common/dto/api-exception';
import { apiRateLimit } from '../common/plans';
import type { ApiKey, CreatedApiKey, Plan, User } from '../contracts';
import {
  displayPrefixOf,
  generateApiKeySecret,
  hashApiKey,
  type ApiKeyEnvironment,
} from './api-key-secret';
import { ApiKeysStore, type ApiKeyRow } from './api-keys-store.service';

/** More keys than anyone needs, but a bound on what one account can pile up. */
export const MAX_KEYS_PER_USER = 25;
export const MAX_NAME_LENGTH = 60;

/**
 * What the site shows for a key: everything except the secret and its hash. The rate limit is worked out
 * from the owner's plan now, not stored, so an upgrade takes effect on existing keys straight away.
 */
export const toApiKey = (row: ApiKeyRow, plan: Plan): ApiKey => ({
  id: row.id,
  name: row.name,
  // Written only by this service, from a validated value.
  environment: row.environment as ApiKeyEnvironment,
  prefix: row.prefix,
  status: row.status === 'revoked' ? 'revoked' : 'active',
  createdAt: row.createdAt.toISOString(),
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  rateLimit: apiRateLimit(plan, row.environment as ApiKeyEnvironment),
});

@Injectable()
export class ApiKeysService {
  constructor(private readonly store: ApiKeysStore) {}

  async list(user: User): Promise<ApiKey[]> {
    const rows = await this.store.list(user.id);
    return rows.map((row) => toApiKey(row, user.plan));
  }

  /** The one place a secret exists in the clear: it is returned here once and only its hash is kept. */
  async create(
    user: User,
    input: { name: string; environment: ApiKeyEnvironment },
  ): Promise<CreatedApiKey> {
    const name = input.name.trim();
    if (!name) {
      throw new ApiException(
        'INVALID_INPUT',
        'Give the key a name so you can recognise it later.',
      );
    }

    const secret = generateApiKeySecret(input.environment);
    const outcome = await this.store.create(
      user.id,
      {
        name,
        environment: input.environment,
        prefix: displayPrefixOf(secret),
        secretHash: hashApiKey(secret),
      },
      MAX_KEYS_PER_USER,
      new Date(),
    );

    if (outcome.status === 'limit') {
      throw new ApiException(
        'CONFLICT',
        `You have ${MAX_KEYS_PER_USER} API keys, the most an account can hold. Delete keys you no longer use.`,
      );
    }

    return { key: toApiKey(outcome.key, user.plan), secret };
  }

  async revoke(user: User, id: string): Promise<ApiKey> {
    const row = await this.store.revoke(user.id, id, new Date());
    if (!row) {
      throw this.notFound();
    }
    return toApiKey(row, user.plan);
  }

  async remove(user: User, id: string): Promise<void> {
    if (!(await this.store.remove(user.id, id))) {
      throw this.notFound();
    }
  }

  private notFound() {
    return new ApiException('NOT_FOUND', 'That API key was not found.');
  }
}
