import { Injectable, Logger } from '@nestjs/common';
import { ApiException } from '../common/dto/api-exception';
import { canAccess, tierOf } from '../common/features';
import { LookupService } from '../lookup/lookup.service';
import { TeamsService } from '../teams/teams.service';
import { toUser } from '../users/user.mapper';
import { UsersService } from '../users/users.service';
import { itemStatusOf, summarize } from './bulk-rules';
import {
  BulkStore,
  type ItemOutcome,
  type PendingItem,
  type StoredJob,
} from './bulk-store.service';

/** Lines looked up at once: each makes a few outbound DNS and reputation calls. */
export const CONCURRENCY = 5;
/** How long a worker keeps a job without renewing; renewed after every group of lines, so this is only the crash margin. */
export const LEASE_MS = 60_000;

export type RunResult = 'finished' | 'paused' | 'cancelled';

const QUOTA_SKIPPED = {
  code: 'QUOTA_EXCEEDED',
  message: 'Not looked up: this month’s lookups ran out before this line.',
} as const;
const PLAN_SKIPPED = {
  code: 'PLAN_REQUIRED',
  message: 'Not looked up: the account’s plan no longer includes bulk lookup.',
} as const;

/**
 * Does the work of one bulk job. Each line goes through the ordinary lookup, so it gets the same cache, the same
 * limits and the same charging as a lookup typed into the site: a repeat from the cache is free, a run costs one
 * lookup of the month, a run that gets nothing back is refunded. Lines are not saved to the account's history;
 * the batch keeps its own results. When the month's lookups run out the batch stops and the rest is marked
 * skipped, so nothing is left pending forever.
 */
@Injectable()
export class BulkRunner {
  private readonly logger = new Logger(BulkRunner.name);

  constructor(
    private readonly store: BulkStore,
    private readonly lookup: LookupService,
    private readonly users: UsersService,
    private readonly teams: TeamsService,
  ) {}

  /**
   * Works on a job that the caller holds the lease for, until it is done, `deadline` passes (`paused`: the lease is
   * given back so another job can have a turn), `shouldStop` says so, or the job is deleted (`cancelled`).
   */
  async run(
    job: StoredJob,
    deadline: number,
    shouldStop: () => boolean = () => false,
  ): Promise<RunResult> {
    const row = await this.users.findById(job.userId);
    if (!row) {
      return 'cancelled';
    }
    const user = toUser(row);
    // Checked fresh, in the background, the same as an HTTP request would — a member's access follows
    // whatever their team currently grants, not what it granted when the job was created.
    user.effectivePlan = await this.teams.effectivePlan(user);

    if (!canAccess(tierOf(user), 'bulkLookup')) {
      await this.store.skipRemaining(job.id, PLAN_SKIPPED);
      await this.store.finish(job.id, 'plan', new Date());
      return 'finished';
    }

    for (;;) {
      if (shouldStop() || Date.now() >= deadline) {
        await this.store.releaseLease(job.id, new Date());
        return 'paused';
      }

      const group = await this.store.pending(job.id, CONCURRENCY);
      if (group.length === 0) {
        await this.store.finish(job.id, null, new Date());
        return 'finished';
      }

      const outcomes = await Promise.all(
        group.map((item) => this.lookupOne(user, item)),
      );

      let quotaRanOut = false;
      for (const [index, outcome] of outcomes.entries()) {
        if (outcome === 'quota') {
          quotaRanOut = true;
        } else {
          await this.store.recordItem(job.id, group[index].position, outcome);
        }
      }

      if (quotaRanOut) {
        await this.store.skipRemaining(job.id, QUOTA_SKIPPED);
        await this.store.finish(job.id, 'quota', new Date());
        return 'finished';
      }

      const stillOurs = await this.store.renewLease(
        job.id,
        new Date(Date.now() + LEASE_MS),
      );
      if (!stillOurs) {
        return 'cancelled';
      }
    }
  }

  private async lookupOne(
    user: ReturnType<typeof toUser>,
    item: PendingItem,
  ): Promise<ItemOutcome | 'quota'> {
    try {
      const { result } = await this.lookup.check(
        item.input,
        { user, ip: undefined, skipHistory: true },
        false,
      );
      return {
        status: itemStatusOf(result.status),
        summary: summarize(result),
      };
    } catch (error) {
      if (error instanceof ApiException) {
        if (error.code === 'QUOTA_EXCEEDED') {
          return 'quota';
        }
        return {
          status: 'failed',
          error: { code: error.code, message: error.message },
        };
      }
      this.logger.error(
        `Bulk line ${item.position} (${item.target}) failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        status: 'failed',
        error: { code: 'INTERNAL', message: 'Something broke on our side.' },
      };
    }
  }
}
