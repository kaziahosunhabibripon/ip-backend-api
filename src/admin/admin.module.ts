import { Module } from '@nestjs/common';
import { AbuseModule } from '../abuse/abuse.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { LookupModule } from '../lookup/lookup.module';
import { MailModule } from '../mail/mail.module';
import { UsersModule } from '../users/users.module';
import { AbuseReviewService } from './abuse-review.service';
import { AdminController } from './admin.controller';
import { AdminOverviewService } from './admin-overview.service';
import { AdminStatsStore } from './admin-stats.store';
import { AdminSystemService } from './admin-system.service';
import { AdminUsersService } from './admin-users.service';
import { AuditService } from './audit.service';

@Module({
  imports: [
    AbuseModule,
    ApiKeysModule,
    AuthModule,
    BillingModule,
    LookupModule,
    MailModule,
    UsersModule,
  ],
  controllers: [AdminController],
  providers: [
    AdminStatsStore,
    AdminUsersService,
    AdminSystemService,
    AdminOverviewService,
    AbuseReviewService,
    AuditService,
  ],
})
export class AdminModule {}
