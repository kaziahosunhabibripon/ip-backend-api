import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { HistoryModule } from '../history/history.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [HistoryModule, AlertsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
