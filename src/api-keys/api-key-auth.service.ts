import { Injectable, Logger } from '@nestjs/common';
import { ApiException } from '../common/dto/api-exception';
import type { User } from '../contracts';
import { toUser } from '../users/user.mapper';
import {
  hashApiKey,
  looksLikeApiKey,
  type ApiKeyEnvironment,
} from './api-key-secret';
import { ApiKeysStore } from './api-keys-store.service';

/** What a request authenticated with a key carries: which key it was, not the secret. */
export interface ApiKeyPrincipal {
  id: string;
  environment: ApiKeyEnvironment;
}

const TOUCH_INTERVAL_MS = 60_000;

/** Turns a bearer secret into its owner. Used by `AuthGuard` on the routes that accept API keys. */
@Injectable()
export class ApiKeyAuthService {
  private readonly logger = new Logger(ApiKeyAuthService.name);

  constructor(private readonly store: ApiKeysStore) {}

  /**
   * Null for anything that isn't a live key: wrong shape (never reaches the database), unknown, or revoked.
   * Revocation is immediate because every request looks the key up afresh — nothing is cached.
   */
  async authenticate(
    secret: string,
    now = new Date(),
  ): Promise<{ user: User; key: ApiKeyPrincipal } | null> {
    if (!looksLikeApiKey(secret)) {
      return null;
    }

    const found = await this.store.findActiveByHash(hashApiKey(secret));
    if (!found) {
      return null;
    }

    const { key, owner } = found;
    // Checked on every request, like revocation, so a suspension stops the very next call.
    if (owner.suspendedAt) {
      throw new ApiException(
        'FORBIDDEN',
        'This account has been suspended. Contact support if you think this is a mistake.',
      );
    }

    const stale =
      !key.lastUsedAt ||
      now.getTime() - key.lastUsedAt.getTime() > TOUCH_INTERVAL_MS;
    if (stale) {
      // Bookkeeping only: never make a request wait for it, or fail because of it.
      this.store
        .touch(key.id, now, new Date(now.getTime() - TOUCH_INTERVAL_MS))
        .catch((error: unknown) => {
          this.logger.warn(
            `Could not record use of an API key: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }

    return {
      user: toUser(owner),
      key: { id: key.id, environment: key.environment as ApiKeyEnvironment },
    };
  }
}
