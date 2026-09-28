import { Injectable } from '@nestjs/common';
import { AbuseService } from '../abuse/abuse.service';
import { ApiException } from '../common/dto/api-exception';
import type {
  BulkJob,
  BulkJobPage,
  BulkOverview,
  CreateBulkRequest,
  User,
} from '../contracts';
import {
  MAX_NAME_LENGTH,
  MAX_OPEN_JOBS,
  advertisedBatchSize,
  batchLimitFor,
  prepareEntries,
  toBulkItem,
  toBulkJob,
} from './bulk-rules';
import { BulkStore, type StoredJob } from './bulk-store.service';

/** Jobs shown in the list; older ones are still deleted by housekeeping, not hidden by a page. */
const LIST_LIMIT = 20;
const DEFAULT_PAGE = 100;

@Injectable()
export class BulkService {
  constructor(
    private readonly store: BulkStore,
    private readonly abuse: AbuseService,
  ) {}

  async list(user: User): Promise<BulkOverview> {
    const rows = await this.store.listJobs(user.id, LIST_LIMIT);
    return {
      jobs: await this.toJobs(rows),
      batchSize: advertisedBatchSize(user.effectivePlan),
      openJobsLimit: MAX_OPEN_JOBS,
    };
  }

  async create(user: User, request: CreateBulkRequest): Promise<BulkJob> {
    const entries = request.targets.filter((entry) => entry.trim() !== '');
    if (entries.length === 0) {
      throw new ApiException('INVALID_INPUT', 'Add at least one target.', {
        targets: 'Enter one domain or IP address per line.',
      });
    }

    const limit = batchLimitFor(user.effectivePlan);
    if (entries.length > limit) {
      throw new ApiException(
        'INVALID_INPUT',
        `Your plan takes up to ${limit.toLocaleString('en-US')} targets in one batch; this one has ${entries.length.toLocaleString('en-US')}.`,
        { limit, received: entries.length },
      );
    }

    if ((await this.store.countOpen(user.id)) >= MAX_OPEN_JOBS) {
      throw new ApiException(
        'CONFLICT',
        `You already have ${MAX_OPEN_JOBS} batches running. Wait for one to finish, or delete it, then try again.`,
        { limit: MAX_OPEN_JOBS },
      );
    }

    const { items, duplicates } = prepareEntries(entries);
    for (const item of items) {
      if (item.internal) {
        // The same signal a single lookup of an internal address raises: a few are noise, many are probing.
        void this.abuse.note('account', user.id, 'internal_targets');
      }
    }

    const job = await this.store.createJob(user.id, {
      name: request.name?.trim().slice(0, MAX_NAME_LENGTH) || null,
      duplicates,
      items,
    });
    const [created] = await this.toJobs([job]);
    return created;
  }

  async get(
    user: User,
    id: string,
    offset = 0,
    limit = DEFAULT_PAGE,
  ): Promise<BulkJobPage> {
    const job = await this.store.findJob(user.id, id);
    if (!job) {
      throw new ApiException('NOT_FOUND', 'That batch was not found.');
    }
    const [view] = await this.toJobs([job]);
    const rows = await this.store.pageItems(job.id, offset, limit);
    return { job: view, items: rows.map(toBulkItem), offset, limit };
  }

  async remove(user: User, id: string): Promise<void> {
    if (!(await this.store.deleteJob(user.id, id))) {
      throw new ApiException('NOT_FOUND', 'That batch was not found.');
    }
  }

  private async toJobs(rows: StoredJob[]): Promise<BulkJob[]> {
    const counts = await this.store.countsByStatus(rows.map((row) => row.id));
    return rows.map((row) => toBulkJob(row, counts.get(row.id) ?? {}));
  }
}
