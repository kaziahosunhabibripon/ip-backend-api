import { Module } from '@nestjs/common';
import { ApiUsageController } from './api-usage.controller';
import { ApiUsageService } from './api-usage.service';
import { UsageController } from './usage.controller';
import { UsageEventsService } from './usage-events.service';
import { UsageService } from './usage.service';

@Module({
  controllers: [UsageController, ApiUsageController],
  providers: [UsageService, UsageEventsService, ApiUsageService],
  exports: [UsageService, UsageEventsService],
})
export class UsageModule {}
