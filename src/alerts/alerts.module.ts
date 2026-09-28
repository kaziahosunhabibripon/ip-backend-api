import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { AlertMailService } from './alert-mail.service';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';

@Module({
  imports: [MailModule],
  controllers: [AlertsController],
  providers: [AlertsService, AlertMailService],
  exports: [AlertsService, AlertMailService],
})
export class AlertsModule {}
