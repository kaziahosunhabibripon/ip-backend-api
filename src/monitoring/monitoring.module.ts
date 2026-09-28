import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { LookupModule } from '../lookup/lookup.module';
import { UsersModule } from '../users/users.module';
import { MonitoringController } from './monitoring.controller';
import { MonitoringService } from './monitoring.service';
import { MonitorRunner } from './monitor-runner.service';
import { MonitorScheduler } from './monitor-scheduler.service';
import { MonitorStore } from './monitor-store.service';

@Module({
  imports: [AlertsModule, LookupModule, UsersModule],
  controllers: [MonitoringController],
  providers: [MonitoringService, MonitorStore, MonitorRunner, MonitorScheduler],
})
export class MonitoringModule {}
