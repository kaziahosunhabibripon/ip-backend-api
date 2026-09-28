import { Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { User } from '../contracts';
import type { Database } from '../db/database';
import { auditLog } from '../db/schema';

export type AuditDetail = Record<string, string | number | boolean | null>;

/**
 * The trail of what administrators did: who, what, to whom. Written after the action succeeded; a failure to
 * write it is logged loudly but does not undo or fail an action that has already happened.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@InjectDrizzle() private readonly db: Database) {}

  async record(
    actor: Pick<User, 'id' | 'email'>,
    action: string,
    target: { type: string; id: string },
    detail?: AuditDetail,
  ): Promise<void> {
    try {
      await this.db.insert(auditLog).values({
        actorId: actor.id,
        actorEmail: actor.email,
        action,
        targetType: target.type,
        targetId: target.id,
        detail: detail ?? null,
      });
    } catch (error) {
      this.logger.error(
        `Could not write the audit entry "${action}" for ${target.type} ${target.id} by ${actor.email}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
