import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsString,
  MaxLength,
} from 'class-validator';
import type {
  CreateMonitorRequest,
  InputType,
  MonitoringOverview,
  MonitoringRule,
  MonitorStatus,
  MonitorWatch,
} from '../../contracts';

/** The frequencies the site offers. */
export const MONITOR_INTERVALS = [5, 15, 60, 360, 1440];
export const MONITOR_WATCH: MonitorWatch[] = [
  'dns',
  'ip',
  'provider',
  'security',
];

export class CreateMonitorDto implements CreateMonitorRequest {
  @ApiProperty({
    example: 'example.com',
    description:
      'A domain, URL or IP address, the same input the lookup takes.',
  })
  @MaxLength(2048)
  @IsString()
  target: string;

  @ApiProperty({
    enum: MONITOR_INTERVALS,
    description: 'Minutes between checks.',
    example: 15,
  })
  @IsIn(MONITOR_INTERVALS)
  intervalMinutes: number;

  @ApiProperty({
    enum: MONITOR_WATCH,
    isArray: true,
    description: 'Which kinds of change raise an alert. At least one.',
    example: ['dns', 'ip'],
  })
  @IsIn(MONITOR_WATCH, { each: true })
  @ArrayUnique()
  @ArrayNotEmpty()
  @IsArray()
  watch: MonitorWatch[];
}

export class SetMonitorEnabledDto {
  @ApiProperty({ description: 'false pauses the monitor, true resumes it.' })
  @IsBoolean()
  enabled: boolean;
}

class ChangeCountsDto {
  @ApiProperty() dns: number;
  @ApiProperty() ip: number;
  @ApiProperty() provider: number;
  @ApiProperty() security: number;
}

class LastChangeDto {
  @ApiProperty({ example: 'New address: 104.18.22.91 (Cloudflare).' })
  summary: string;

  @ApiProperty({ format: 'date-time' })
  at: string;
}

export class MonitoringRuleDto implements MonitoringRule {
  @ApiProperty() id: string;

  @ApiProperty({ example: 'api.example.com' })
  target: string;

  @ApiProperty({ enum: ['domain', 'ipv4', 'ipv6'] })
  targetType: InputType;

  @ApiProperty({
    enum: ['healthy', 'changed', 'failing', 'paused'],
    description:
      '`paused` when switched off; `failing` after three runs in a row could not read the target; `changed` while there are unread change alerts; otherwise `healthy`.',
  })
  status: MonitorStatus;

  @ApiProperty({ example: 15 })
  intervalMinutes: number;

  @ApiProperty()
  enabled: boolean;

  @ApiProperty({ enum: MONITOR_WATCH, isArray: true })
  watch: MonitorWatch[];

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  lastCheckedAt: string | null;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  nextCheckAt: string | null;

  @ApiProperty({
    type: ChangeCountsDto,
    description: 'Alerts raised over the last 30 days, by kind of change.',
  })
  changes: ChangeCountsDto;

  @ApiProperty({ required: false, type: LastChangeDto })
  lastChange?: LastChangeDto;
}

export class MonitoringOverviewDto implements MonitoringOverview {
  @ApiProperty({ type: [MonitoringRuleDto] })
  rules: MonitoringRuleDto[];

  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'How many monitors the plan allows; null when unlimited.',
  })
  limit: number | null;
}
