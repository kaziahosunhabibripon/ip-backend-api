import { ApiProperty } from '@nestjs/swagger';
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
  CheckHistory,
  HistoryQuery,
  HistoryRangeFilter,
  HistorySort,
  HistoryStatus,
  HistoryTypeFilter,
  InputType,
  Paginated,
} from '../../contracts';

export class HistoryQueryDto implements HistoryQuery {
  @ApiProperty({
    required: false,
    description: 'Case-insensitive "contains" match on the target.',
  })
  @IsOptional()
  @MaxLength(253)
  @IsString()
  q?: string;

  @ApiProperty({
    required: false,
    enum: ['all', 'domain', 'ip'],
    default: 'all',
  })
  @IsOptional()
  @IsIn(['all', 'domain', 'ip'])
  type?: HistoryTypeFilter;

  @ApiProperty({
    required: false,
    enum: ['any', 'today', '7d', '30d'],
    default: 'any',
    description:
      '`today` is since 00:00 UTC; `7d` and `30d` are rolling windows.',
  })
  @IsOptional()
  @IsIn(['any', 'today', '7d', '30d'])
  range?: HistoryRangeFilter;

  @ApiProperty({
    required: false,
    enum: ['newest', 'oldest', 'target', 'ips'],
    default: 'newest',
  })
  @IsOptional()
  @IsIn(['newest', 'oldest', 'target', 'ips'])
  sort?: HistorySort;

  @ApiProperty({ required: false, minimum: 1, default: 1 })
  @IsOptional()
  @Min(1)
  @IsInt()
  @Type(() => Number)
  page?: number;

  @ApiProperty({ required: false, minimum: 1, maximum: 100, default: 10 })
  @IsOptional()
  @Max(100)
  @Min(1)
  @IsInt()
  @Type(() => Number)
  pageSize?: number;
}

export class CheckHistoryDto implements CheckHistory {
  @ApiProperty({
    example: 'chk_h3k2p9x0q1w8',
    description: 'Also the id for `GET /check/:id`.',
  })
  id: string;

  @ApiProperty({ example: 'github.com' })
  target: string;

  @ApiProperty({ enum: ['domain', 'ipv4', 'ipv6'] })
  type: InputType;

  @ApiProperty({ example: 2 })
  ipCount: number;

  @ApiProperty({ enum: ['completed', 'partial', 'no_records', 'failed'] })
  status: HistoryStatus;

  @ApiProperty({ format: 'date-time' })
  checkedAt: string;
}

export class PaginatedHistoryDto implements Paginated<CheckHistory> {
  @ApiProperty({ type: [CheckHistoryDto] })
  items: CheckHistoryDto[];

  @ApiProperty({ description: 'Matches across all pages.' })
  total: number;

  @ApiProperty()
  page: number;

  @ApiProperty()
  pageSize: number;
}
