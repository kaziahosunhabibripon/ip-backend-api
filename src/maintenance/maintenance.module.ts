import { Module } from '@nestjs/common';
import { MaintenanceScheduler } from './maintenance-scheduler.service';
import { MaintenanceService } from './maintenance.service';

@Module({
  providers: [MaintenanceService, MaintenanceScheduler],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
