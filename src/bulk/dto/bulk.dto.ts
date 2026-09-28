import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type {
  ApiErrorCode,
  BulkItem,
  BulkItemError,
  BulkItemStatus,
  BulkItemSummary,
  BulkJob,
  BulkJobPage,
  BulkJobStatus,
  BulkOverview,
  BulkStopReason,
  ConnectionType,
  CreateBulkRequest,
  InputType,
  RiskLevel,
  SignalState,
} from '../../contracts';
import { BULK_HARD_CAP, MAX_NAME_LENGTH } from '../bulk-rules';

export const ITEMS_PAGE_MAX = 500;

export class CreateBulkDto implements CreateBulkRequest {
  @ApiProperty({
    type: [String],
    example: ['example.com', '1.1.1.1', 'https://github.com/about'],
    description: `One domain, URL or IP address per entry, as typed. Blank entries are dropped and repeats are left out. The plan decides how many one batch may hold (Pro 100, Business 1,000); nothing above ${BULK_HARD_CAP.toLocaleString('en-US')} is ever accepted.`,
  })
  @MaxLength(2048, { each: true })
  @IsString({ each: true })
  @ArrayMaxSize(BULK_HARD_CAP)
  @ArrayNotEmpty()
  @IsArray()
  targets: string[];

  @ApiProperty({ required: false, maxLength: MAX_NAME_LENGTH })
  @IsOptional()
  @MaxLength(MAX_NAME_LENGTH)
  @IsString()
  name?: string;
}

export class BulkItemsQueryDto {
  @ApiProperty({ required: false, default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  @ApiProperty({
    required: false,
    default: 100,
    minimum: 1,
    maximum: ITEMS_PAGE_MAX,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ITEMS_PAGE_MAX)
  limit?: number;
}

const ITEM_STATUSES: BulkItemStatus[] = [
  'pending',
  'completed',
  'partial',
  'no_records',
  'failed',
  'invalid',
  'skipped',
];

export class BulkJobDto implements BulkJob {
  @ApiProperty() id: string;

  @ApiProperty({ nullable: true, type: String }) name: string | null;

  @ApiProperty({ enum: ['queued', 'running', 'completed'] })
  status: BulkJobStatus;

  @ApiProperty({
    description:
      'Lines in the batch, after blanks and repeats were removed. Includes lines that were refused as invalid.',
  })
  total: number;

  @ApiProperty({ description: 'Lines that are no longer pending.' })
  processed: number;

  @ApiProperty({
    description: 'Lines that came back with a result, complete or partial.',
  })
  succeeded: number;

  @ApiProperty({ description: 'Lines that failed or were invalid.' })
  failed: number;

  @ApiProperty({ description: 'Lines never run because the batch stopped.' })
  skipped: number;

  @ApiProperty({ description: 'Repeats of an earlier line, left out.' })
  duplicates: number;

  @ApiProperty({
    enum: ['quota', 'plan'],
    nullable: true,
    type: String,
    description:
      'Why the batch stopped early: the month’s lookups ran out (`quota`) or the plan no longer includes bulk lookup (`plan`).',
  })
  stoppedReason: BulkStopReason | null;

  @ApiProperty({ format: 'date-time' }) createdAt: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  startedAt: string | null;
  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  finishedAt: string | null;
}

export class BulkOverviewDto implements BulkOverview {
  @ApiProperty({ type: [BulkJobDto], description: 'Newest first.' })
  jobs: BulkJobDto[];

  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      'Most lines one batch may hold on this plan; null when it is negotiated (Enterprise).',
  })
  batchSize: number | null;

  @ApiProperty({
    description: 'Batches that may be queued or running at once.',
  })
  openJobsLimit: number;
}

class BulkItemSummaryDto implements BulkItemSummary {
  @ApiProperty({ type: [String] }) ips: string[];
  @ApiProperty({ nullable: true, type: String }) country: string | null;
  @ApiProperty({ nullable: true, type: String }) city: string | null;
  @ApiProperty({ nullable: true, type: Number }) asn: number | null;
  @ApiProperty({ nullable: true, type: String }) organization: string | null;
  @ApiProperty({ nullable: true, type: String })
  connectionType: ConnectionType | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: '0 (clean) – 100 (abusive).',
  })
  riskScore: number | null;
  @ApiProperty({ nullable: true, type: String }) riskLevel: RiskLevel | null;
  @ApiProperty({ nullable: true, type: String }) vpn: SignalState | null;
  @ApiProperty({ nullable: true, type: String }) proxy: SignalState | null;
  @ApiProperty({ nullable: true, type: String }) tor: SignalState | null;
  @ApiProperty({ nullable: true, type: String })
  datacenter: SignalState | null;
}

class BulkItemErrorDto implements BulkItemError {
  @ApiProperty({ example: 'INVALID_INPUT' }) code: ApiErrorCode;
  @ApiProperty() message: string;
}

export class BulkItemDto implements BulkItem {
  @ApiProperty({
    description:
      'Line number within the batch, from 1, in the order submitted.',
  })
  position: number;

  @ApiProperty({ description: 'Exactly what was submitted.' })
  input: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Normalised domain or IP; null for an invalid line.',
  })
  target: string | null;

  @ApiProperty({
    enum: ['domain', 'ipv4', 'ipv6'],
    nullable: true,
    type: String,
  })
  type: InputType | null;

  @ApiProperty({ enum: ITEM_STATUSES }) status: BulkItemStatus;

  @ApiProperty({ type: BulkItemSummaryDto, nullable: true })
  summary: BulkItemSummaryDto | null;

  @ApiProperty({ type: BulkItemErrorDto, nullable: true })
  error: BulkItemErrorDto | null;
}

export class BulkJobPageDto implements BulkJobPage {
  @ApiProperty({ type: BulkJobDto }) job: BulkJobDto;
  @ApiProperty({ type: [BulkItemDto] }) items: BulkItemDto[];
  @ApiProperty() offset: number;
  @ApiProperty() limit: number;
}
