import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import type { AnalyticsRange, Usage, UsageMeter } from '../../contracts';

export class UsageMeterDto implements UsageMeter {
  @ApiProperty({ example: 42 })
  used: number;

  @ApiProperty({
    nullable: true,
    description: 'Null means unlimited / custom.',
  })
  limit: number | null;
}

export class UsageDto implements Usage {
  @ApiProperty({ type: UsageMeterDto })
  lookups: UsageMeterDto;

  @ApiProperty({
    type: UsageMeterDto,
    description:
      'Key-authenticated requests. Always 0 until API keys ship (Phase 5).',
  })
  apiRequests: UsageMeterDto;

  @ApiProperty({ type: UsageMeterDto })
  monitors: UsageMeterDto;

  @ApiProperty({
    format: 'date-time',
    description:
      'Start of the current calendar month (UTC), until billing periods exist.',
  })
  periodStart: string;

  @ApiProperty({ format: 'date-time' })
  periodEnd: string;
}

export class AnalyticsQueryDto {
  @ApiProperty({
    required: false,
    enum: ['7d', '30d', '90d'],
    default: '30d',
  })
  @IsOptional()
  @IsIn(['7d', '30d', '90d'], { message: 'range must be one of 7d, 30d, 90d.' })
  range?: AnalyticsRange;
}

const point = (date: string, successful: number, failed: number) => ({
  date,
  successful,
  failed,
});

export class UsageAnalyticsDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'The `UsageAnalytics` shape from ipscope-web `types/platform.ts`: `totals` (each `{ value, delta }`, delta = change versus the previous equal period, 0 when there was nothing to compare), a `checks` and a `latency` series with one point per UTC day (days without activity are zeros), and the five most-checked saved targets.',
    example: {
      range: '7d',
      totals: {
        totalChecks: { value: 34, delta: 0.21 },
        successfulChecks: { value: 33, delta: 0.22 },
        failedChecks: { value: 1, delta: 0 },
        apiRequests: { value: 0, delta: 0 },
        cacheHitRate: { value: 0.27, delta: 0.05 },
        providerLatencyMs: { value: 96, delta: -0.04 },
      },
      checks: [point('2026-09-18', 4, 0), point('2026-09-19', 6, 1)],
      latency: [{ date: '2026-09-18', dns: 38, geo: 0, asn: 0, security: 210 }],
      topTargets: [{ target: 'github.com', checks: 7 }],
    },
  })
  analytics: Record<string, unknown>;
}
