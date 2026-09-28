import { Module } from '@nestjs/common';
import { AbuseModule } from '../abuse/abuse.module';
import { LookupModule } from '../lookup/lookup.module';
import { UsersModule } from '../users/users.module';
import { BulkController } from './bulk.controller';
import { BulkRunner } from './bulk-runner.service';
import { BulkScheduler } from './bulk-scheduler.service';
import { BulkService } from './bulk.service';
import { BulkStore } from './bulk-store.service';

@Module({
  imports: [AbuseModule, LookupModule, UsersModule],
  controllers: [BulkController],
  providers: [BulkService, BulkStore, BulkRunner, BulkScheduler],
})
export class BulkModule {}
