import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { UsersModule } from '../users/users.module';
import { BillingController } from './billing.controller';
import { BillingJobs } from './billing-jobs.service';
import { BillingMailService } from './billing-mail.service';
import { BillingScheduler } from './billing-scheduler.service';
import { BillingService } from './billing.service';
import { BillingStore } from './billing-store.service';
import { GatewayClient } from './gateway.client';
import { GatewayWebhookController } from './gateway-webhook.controller';

@Module({
  imports: [MailModule, UsersModule],
  controllers: [BillingController, GatewayWebhookController],
  providers: [
    GatewayClient,
    BillingStore,
    BillingMailService,
    BillingService,
    BillingJobs,
    BillingScheduler,
  ],
  // The admin view reports whether billing is on.
  exports: [GatewayClient],
})
export class BillingModule {}
