import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ApiErrorResponses } from '../common/decorators/api-error-responses.decorator';
import { RequiredUser } from '../common/decorators/current-user.decorator';
import { RequiresPlan } from '../common/decorators/requires-plan.decorator';
import { requiredPlan } from '../common/features';
import type { BulkJob, BulkJobPage, BulkOverview, User } from '../contracts';
import { BulkService } from './bulk.service';
import {
  BulkItemsQueryDto,
  BulkJobDto,
  BulkJobPageDto,
  BulkOverviewDto,
  CreateBulkDto,
} from './dto/bulk.dto';

@ApiTags('bulk')
@ApiCookieAuth()
@Controller('bulk')
@RequiresPlan(requiredPlan('bulkLookup'))
export class BulkController {
  constructor(private readonly bulk: BulkService) {}

  @Get()
  @ApiOperation({
    summary: 'The caller’s batches and the plan’s batch size',
    description:
      'Newest first, the latest 20. Needs the Pro plan or higher; lower plans get 403 PLAN_REQUIRED.',
  })
  @ApiOkResponse({ type: BulkOverviewDto })
  @ApiErrorResponses(401, 403)
  list(@RequiredUser() user: User): Promise<BulkOverview> {
    return this.bulk.list(user);
  }

  @Post()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Look up many targets in one batch',
    description: [
      'Queues the batch and answers at once; a background worker looks the targets up and you poll `GET /bulk/{id}` for progress.',
      '',
      '**Charging.** Each line is an ordinary lookup: a result served from the cache is free, a fresh one costs one lookup of the month, and a line that gets nothing back costs nothing. If the month’s lookups run out the batch stops and the lines left are `skipped` (`stoppedReason: "quota"`).',
      '',
      '**Lines.** Blank entries are dropped and repeats are left out (counted in `duplicates`). A line that is not a domain or public IP address is kept as `invalid` with the reason, and costs nothing. Batch results are not added to the account’s history.',
      '',
      '**Limits.** The plan sets the batch size (Pro 100, Business 1,000, Enterprise by agreement); two batches may be queued or running at once (409 CONFLICT beyond that). Finished batches are kept for 30 days.',
    ].join('\n'),
  })
  @ApiCreatedResponse({ type: BulkJobDto })
  @ApiErrorResponses(401, 403, 409, 422, 429)
  create(
    @RequiredUser() user: User,
    @Body() dto: CreateBulkDto,
  ): Promise<BulkJob> {
    return this.bulk.create(user, dto);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'A batch with its lines',
    description:
      'The batch’s progress counts and a page of its lines in the order submitted (`offset`, `limit` up to 500). Each finished line carries a summary of its result, not the whole report: look the target up on its own to open that.',
  })
  @ApiOkResponse({ type: BulkJobPageDto })
  @ApiErrorResponses(401, 403, 404, 422)
  get(
    @RequiredUser() user: User,
    @Param('id') id: string,
    @Query() query: BulkItemsQueryDto,
  ): Promise<BulkJobPage> {
    return this.bulk.get(user, id, query.offset, query.limit);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete a batch',
    description:
      'Removes the batch and its results. A batch that is still running is cancelled: lines already looked up stay charged, the rest never run.',
  })
  @ApiNoContentResponse()
  @ApiErrorResponses(401, 403, 404)
  remove(@RequiredUser() user: User, @Param('id') id: string): Promise<void> {
    return this.bulk.remove(user, id);
  }
}
