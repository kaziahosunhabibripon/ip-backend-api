import { Module } from '@nestjs/common';
import { ApiKeyAuthService } from './api-key-auth.service';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';
import { ApiKeysStore } from './api-keys-store.service';

@Module({
  controllers: [ApiKeysController],
  providers: [ApiKeysStore, ApiKeysService, ApiKeyAuthService],
  // AuthGuard (in AuthModule) authenticates bearer keys with this; an administrator can revoke any key through the store.
  exports: [ApiKeyAuthService, ApiKeysStore],
})
export class ApiKeysModule {}
