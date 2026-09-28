import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { AuthGuard } from '../common/guards/auth.guard';
import { LookupModule } from '../lookup/lookup.module';
import { MailModule } from '../mail/mail.module';
import { UsageModule } from '../usage/usage.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthMailService } from './auth-mail.service';
import { AuthService } from './auth.service';
import { AuthTokenService } from './auth-token.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';

@Module({
  imports: [UsersModule, MailModule, UsageModule, ApiKeysModule, LookupModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthMailService,
    AuthTokenService,
    PasswordService,
    SessionService,
    // Every route requires a session unless it's marked @Public().
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService, AuthTokenService, PasswordService, SessionService],
})
export class AuthModule {}
