import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, desc, eq, sql, type InferSelectModel } from 'drizzle-orm';
import type { Database } from '../db/database';
import { abuseFlags, apiKeys, blockedVisitors, users } from '../db/schema';
import {
  severityFor,
  shouldReopen,
  type AbuseKind,
  type AbuseReason,
} from './abuse-rules';

export type AbuseFlagRow = InferSelectModel<typeof abuseFlags>;
export type AbuseStatus = 'open' | 'blocked' | 'dismissed';

/** A short, readable stand-in for a hashed network: enough to tell two apart, useless for finding the person. */
export const networkLabel = (visitorHash: string) =>
  `net:${visitorHash.slice(0, 8)}…${visitorHash.slice(-4)}`;

/** Database access for abuse flags and the network blocklist. What counts as abuse is decided in `abuse-rules.ts`. */
@Injectable()
export class AbuseStore {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /**
   * Creates the flag for this (kind, subject, reason) or raises the existing one. `events` only ever goes up
   * within a flag (it is the worst window seen), severity follows it, and a dismissed flag comes back to
   * `open` only when the behaviour has doubled since it was dismissed. A blocked one stays blocked.
   */
  async raise(
    input: {
      kind: AbuseKind;
      subjectKey: string;
      reason: AbuseReason;
      events: number;
    },
    now = new Date(),
  ): Promise<void> {
    const severity = severityFor(input.reason, input.events);
    if (!severity) {
      return;
    }
    const label = await this.labelFor(input.kind, input.subjectKey);

    await this.db.transaction(async (tx) => {
      await tx
        .insert(abuseFlags)
        .values({
          kind: input.kind,
          subjectKey: input.subjectKey,
          subjectLabel: label,
          reason: input.reason,
          severity,
          events: input.events,
          firstSeenAt: now,
          lastSeenAt: now,
        })
        .onConflictDoNothing();

      const [row] = await tx
        .select()
        .from(abuseFlags)
        .where(
          and(
            eq(abuseFlags.kind, input.kind),
            eq(abuseFlags.subjectKey, input.subjectKey),
            eq(abuseFlags.reason, input.reason),
          ),
        )
        .for('update')
        .limit(1);
      if (!row) {
        return;
      }

      const events = Math.max(row.events, input.events);
      await tx
        .update(abuseFlags)
        .set({
          events,
          severity: severityFor(input.reason, events) ?? severity,
          subjectLabel: label,
          lastSeenAt: now,
          status: shouldReopen(row.status, events, row.eventsAtDecision)
            ? 'open'
            : row.status,
        })
        .where(eq(abuseFlags.id, row.id));
    });
  }

  /** Open flags first (worst and freshest at the top), then the ones already decided. */
  list(limit: number): Promise<AbuseFlagRow[]> {
    return this.db
      .select()
      .from(abuseFlags)
      .orderBy(
        sql`case ${abuseFlags.status} when 'open' then 0 else 1 end`,
        sql`case ${abuseFlags.severity} when 'high' then 0 when 'medium' then 1 else 2 end`,
        desc(abuseFlags.lastSeenAt),
        asc(abuseFlags.id),
      )
      .limit(limit);
  }

  async get(id: string): Promise<AbuseFlagRow | undefined> {
    const [row] = await this.db
      .select()
      .from(abuseFlags)
      .where(eq(abuseFlags.id, id))
      .limit(1);
    return row;
  }

  async decide(
    id: string,
    status: AbuseStatus,
    decidedBy: string,
    now = new Date(),
  ): Promise<AbuseFlagRow | undefined> {
    const [row] = await this.db
      .update(abuseFlags)
      .set({
        status,
        decidedBy,
        decidedAt: now,
        // Reopening starts the "has it doubled?" comparison afresh.
        eventsAtDecision: status === 'open' ? 0 : sql`${abuseFlags.events}`,
      })
      .where(eq(abuseFlags.id, id))
      .returning();
    return row;
  }

  async isBlocked(visitorHash: string): Promise<boolean> {
    const [row] = await this.db
      .select({ visitorHash: blockedVisitors.visitorHash })
      .from(blockedVisitors)
      .where(eq(blockedVisitors.visitorHash, visitorHash))
      .limit(1);
    return row !== undefined;
  }

  async block(
    visitorHash: string,
    reason: string,
    blockedBy: string,
  ): Promise<void> {
    await this.db
      .insert(blockedVisitors)
      .values({ visitorHash, reason, blockedBy })
      .onConflictDoNothing();
  }

  async unblock(visitorHash: string): Promise<void> {
    await this.db
      .delete(blockedVisitors)
      .where(eq(blockedVisitors.visitorHash, visitorHash));
  }

  private async labelFor(kind: AbuseKind, subjectKey: string): Promise<string> {
    if (kind === 'account') {
      const [row] = await this.db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, subjectKey))
        .limit(1);
      return row?.email ?? subjectKey;
    }
    if (kind === 'api_key') {
      const [row] = await this.db
        .select({ prefix: apiKeys.prefix })
        .from(apiKeys)
        .where(eq(apiKeys.id, subjectKey))
        .limit(1);
      return row?.prefix ?? subjectKey;
    }
    return networkLabel(subjectKey);
  }
}
