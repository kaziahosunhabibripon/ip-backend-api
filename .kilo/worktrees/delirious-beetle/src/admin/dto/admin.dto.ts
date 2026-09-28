import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type {
  AbuseFlag,
  AdminOverview,
  AdminUser,
  AdminUsersPage,
  HealthStatus,
  MetricTotal,
  Plan,
  ProviderHealth,
  Role,
  SubscriptionEvent,
  SystemService,
  UserAccountStatus,
} from '../../contracts';

const PLANS = ['free', 'pro', 'business', 'enterprise'];

export class ListAdminUsersQueryDto {
  @ApiPropertyOptional({
    description: 'Matches part of a name or an email, case-insensitively.',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    enum: ['all', 'active', 'pending', 'suspended'],
    default: 'all',
    description: '`pending` is an account whose email is not verified yet.',
  })
  @IsOptional()
  @IsIn(['all', 'active', 'pending', 'suspended'])
  status?: 'all' | UserAccountStatus;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class SuspendUserDto {
  @ApiPropertyOptional({
    maxLength: 300,
    description:
      'Kept with the account and in the audit trail. Never shown to the user.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class AdminUserDto implements AdminUser {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() email: string;
  @ApiProperty({ enum: PLANS }) plan: Plan;
  @ApiProperty({ enum: ['user', 'admin'] }) role: Role;
  @ApiProperty({ enum: ['active', 'suspended', 'pending'] })
  status: UserAccountStatus;
  @ApiProperty({
    format: 'date-time',
    description:
      'The latest of any session activity, the last lookup, and sign-up.',
  })
  lastActiveAt: string;
  @ApiProperty({
    description:
      'Lookups (web and API, cache hits included) in the last 30 days.',
  })
  checks30d: number;
}

export class AdminUsersPageDto implements AdminUsersPage {
  @ApiProperty({ type: [AdminUserDto] }) users: AdminUserDto[];
  @ApiProperty({ description: 'Every match, not just this page.' })
  total: number;
}

class MetricTotalDto implements MetricTotal {
  @ApiProperty() value: number;
  @ApiProperty({
    description:
      'Change against the previous period as a ratio (0.12 = +12%). 0 when there is nothing to compare with.',
  })
  delta: number;
}

class TotalsDto {
  @ApiProperty({
    type: MetricTotalDto,
    description: 'Accounts now; delta against 30 days ago.',
  })
  totalUsers: MetricTotalDto;
  @ApiProperty({
    type: MetricTotalDto,
    description:
      'Signed-in users who looked something up in the last 30 days; delta against the 30 days before.',
  })
  activeUsers: MetricTotalDto;
  @ApiProperty({
    type: MetricTotalDto,
    description:
      'Users on a paid plan; delta against 30 days ago, worked out from recorded subscription changes.',
  })
  premiumUsers: MetricTotalDto;
  @ApiProperty({
    type: MetricTotalDto,
    description:
      'All lookups on the last complete UTC day; delta against the day before.',
  })
  dailyChecks: MetricTotalDto;
  @ApiProperty({
    type: MetricTotalDto,
    description:
      'Requests made with API keys in the last 30 days; delta against the 30 days before.',
  })
  apiRequests: MetricTotalDto;
  @ApiProperty({
    type: MetricTotalDto,
    description:
      'Lookups that came back with nothing at all in the last 24 hours; delta against the 24 hours before.',
  })
  systemErrors: MetricTotalDto;
}

class PlanMixDto {
  @ApiProperty({ enum: PLANS }) plan: Plan;
  @ApiProperty() users: number;
}

class DailyChecksDto {
  @ApiProperty({ example: '2026-09-26' }) date: string;
  @ApiProperty({
    description:
      'Signed-out lookups that used quota (repeats served from the cache are not counted).',
  })
  anonymous: number;
  @ApiProperty({
    description: 'Signed-in web lookups, cache hits and failures included.',
  })
  account: number;
  @ApiProperty({ description: 'Requests made with API keys.' }) api: number;
}

class SubscriptionEventDto implements SubscriptionEvent {
  @ApiProperty() id: string;
  @ApiProperty({ description: 'The customer’s email.' }) user: string;
  @ApiProperty({
    enum: ['upgraded', 'downgraded', 'canceled', 'renewed', 'payment_failed'],
  })
  event: SubscriptionEvent['event'];
  @ApiProperty({ enum: PLANS }) plan: Plan;
  @ApiProperty({ description: 'US dollars.' }) amount: number;
  @ApiProperty({ format: 'date-time' }) at: string;
}

class ProviderHealthDto implements ProviderHealth {
  @ApiProperty() id: string;
  @ApiProperty() provider: string;
  @ApiProperty() role: string;
  @ApiProperty({ enum: ['healthy', 'degraded', 'down'] }) status: HealthStatus;
  @ApiProperty({
    description:
      'Average milliseconds of the calls that answered, over the last 15 minutes.',
  })
  latencyMs: number;
  @ApiProperty({ description: '0–1, over the last 15 minutes.' })
  errorRate: number;
  @ApiProperty({
    description:
      'Fresh provider calls in the last 15 minutes, on this API instance. Cache hits never reach a provider.',
  })
  calls: number;
  @ApiPropertyOptional() detail?: string;
}

class MetricDto {
  @ApiProperty() label: string;
  @ApiProperty() value: string;
}

class SystemServiceDto implements SystemService {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty({ enum: ['healthy', 'degraded', 'down'] }) status: HealthStatus;
  @ApiProperty() detail: string;
  @ApiProperty({ type: MetricDto }) metric: MetricDto;
}

export class AbuseFlagDto implements AbuseFlag {
  @ApiProperty() id: string;
  @ApiProperty({
    description:
      'Readable, never a raw IP: an email, a key prefix, or a shortened hash of a network.',
  })
  subject: string;
  @ApiProperty({
    enum: ['anonymous_session', 'ip_address', 'api_key', 'account'],
  })
  kind: AbuseFlag['kind'];
  @ApiProperty() reason: string;
  @ApiProperty({ enum: ['low', 'medium', 'high'] })
  severity: AbuseFlag['severity'];
  @ApiProperty({ description: 'The worst count seen in one counting window.' })
  events: number;
  @ApiProperty({ format: 'date-time' }) lastSeenAt: string;
  @ApiProperty({ enum: ['open', 'blocked', 'dismissed'] })
  status: AbuseFlag['status'];
}

export class AdminOverviewDto implements AdminOverview {
  @ApiProperty({ type: TotalsDto }) totals: TotalsDto;
  @ApiProperty({
    description:
      'Monthly value of the paid plans running right now, in US dollars (annual periods divided by twelve). Plans are prepaid rather than recurring, so this is what is currently paid for. A hand-arranged Enterprise plan has no payment here and is not counted.',
  })
  mrr: number;
  @ApiProperty({ type: [PlanMixDto] }) planMix: PlanMixDto[];
  @ApiProperty({
    type: [DailyChecksDto],
    description:
      'The last 30 UTC days, oldest first, today included (still filling up).',
  })
  dailyChecks: DailyChecksDto[];
  @ApiProperty({
    type: [AdminUserDto],
    description:
      'The 100 most recently active users. Use `GET /admin/users` to search the rest.',
  })
  users: AdminUserDto[];
  @ApiProperty({
    type: [SubscriptionEventDto],
    description: 'The 20 most recent.',
  })
  subscriptionEvents: SubscriptionEventDto[];
  @ApiProperty({ type: [ProviderHealthDto] }) providers: ProviderHealthDto[];
  @ApiProperty({ type: [SystemServiceDto] }) services: SystemServiceDto[];
  @ApiProperty({
    type: [AbuseFlagDto],
    description: 'Open flags first, worst and freshest at the top; up to 50.',
  })
  abuse: AbuseFlagDto[];
}
