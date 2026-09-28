import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { DrizzleModule } from '@nestjs/drizzle';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { drizzle } from 'drizzle-orm/node-postgres';
import { AccountModule } from './account/account.module';
import { AdminModule } from './admin/admin.module';
import { AlertsModule } from './alerts/alerts.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { BulkModule } from './bulk/bulk.module';
import { CacheModule } from './cache/cache.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';
import { databaseConnection } from './config/database.config';
import { isProductionEnvironment, loadEnvironment } from './config/env.config';
import * as schema from './db/schema';
import { HealthModule } from './health/health.module';
import { HistoryModule } from './history/history.module';
import { LookupModule } from './lookup/lookup.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { buildLoggerParams } from './observability/logging.config';
import { TeamsModule } from './teams/teams.module';
import { UsageModule } from './usage/usage.module';

loadEnvironment();

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      cache: true,
    }),
    DrizzleModule.forRoot({
      drizzle,
      connection: databaseConnection,
      schema,
    }),
    LoggerModule.forRoot(
      buildLoggerParams({
        production: isProductionEnvironment(),
        level: process.env.LOG_LEVEL,
      }),
    ),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    CacheModule,
    AuthModule,
    TeamsModule,
    AccountModule,
    LookupModule,
    HistoryModule,
    AlertsModule,
    ApiKeysModule,
    BillingModule,
    MonitoringModule,
    BulkModule,
    MaintenanceModule,
    DashboardModule,
    UsageModule,
    AdminModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: ApiExceptionFilter,
    },
  ],
})
export class AppModule {}
