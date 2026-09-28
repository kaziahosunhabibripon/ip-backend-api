import { Injectable } from '@nestjs/common';
import { describeReason, isAbuseReason } from '../abuse/abuse-rules';
import { AbuseService } from '../abuse/abuse.service';
import {
  AbuseStore,
  type AbuseFlagRow,
  type AbuseStatus,
} from '../abuse/abuse-store.service';
import { ApiKeysStore } from '../api-keys/api-keys-store.service';
import { ApiException } from '../common/dto/api-exception';
import type { AbuseDecision, AbuseFlag, User } from '../contracts';
import { toAbuseFlag } from './admin-overview.service';
import { AdminUsersService } from './admin-users.service';
import { AuditService } from './audit.service';

const NOT_FOUND = () =>
  new ApiException('NOT_FOUND', 'That abuse flag was not found.');

/**
 * What an administrator's decision on a flag actually does. Blocking is real: an account is suspended, an API key
 * is revoked, a network is refused anonymous lookups. Dismissing changes only the flag. Reopening lifts what a
 * block did — except a key, which is revoked for good: its owner can create a new one.
 */
@Injectable()
export class AbuseReviewService {
  constructor(
    private readonly flags: AbuseStore,
    private readonly abuse: AbuseService,
    private readonly users: AdminUsersService,
    private readonly keys: ApiKeysStore,
    private readonly audit: AuditService,
  ) {}

  async decide(
    actor: User,
    flagId: string,
    decision: AbuseDecision,
  ): Promise<AbuseFlag> {
    const flag = await this.flags.get(flagId);
    if (!flag) {
      throw NOT_FOUND();
    }

    let status: AbuseStatus;
    if (decision === 'block') {
      if (flag.status !== 'blocked') {
        await this.enforce(actor, flag);
      }
      status = 'blocked';
    } else if (decision === 'dismiss') {
      if (flag.status === 'blocked') {
        throw new ApiException(
          'CONFLICT',
          'This one is blocked. Reopen it to lift the block before dismissing it.',
        );
      }
      status = 'dismissed';
    } else {
      if (flag.status === 'blocked') {
        await this.lift(actor, flag);
      }
      status = 'open';
    }

    const updated = await this.flags.decide(flagId, status, actor.id);
    if (!updated) {
      throw NOT_FOUND();
    }
    await this.audit.record(
      actor,
      `abuse.${decision}`,
      { type: 'abuse_flag', id: flag.id },
      { kind: flag.kind, subject: flag.subjectLabel, reason: flag.reason },
    );
    return toAbuseFlag(updated);
  }

  private async enforce(actor: User, flag: AbuseFlagRow): Promise<void> {
    if (flag.kind === 'account') {
      await this.users.suspend(
        actor,
        flag.subjectKey,
        'Blocked after an abuse review',
      );
      return;
    }
    if (flag.kind === 'api_key') {
      if (!(await this.keys.revokeAny(flag.subjectKey, new Date()))) {
        throw new ApiException('CONFLICT', 'That API key no longer exists.');
      }
      return;
    }
    await this.abuse.blockVisitor(
      flag.subjectKey,
      isAbuseReason(flag.reason)
        ? describeReason(flag.reason, flag.events)
        : flag.reason,
      actor.id,
    );
  }

  private async lift(actor: User, flag: AbuseFlagRow): Promise<void> {
    if (flag.kind === 'account') {
      await this.users.reactivate(actor, flag.subjectKey);
      return;
    }
    if (flag.kind === 'api_key') {
      throw new ApiException(
        'CONFLICT',
        "A revoked API key can't be restored. Its owner can create a new one.",
      );
    }
    await this.abuse.unblockVisitor(flag.subjectKey);
  }
}
