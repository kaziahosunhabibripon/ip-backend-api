import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import {
  and,
  asc,
  desc,
  eq,
  isNotNull,
  sql,
  type InferSelectModel,
} from 'drizzle-orm';
import { ApiException } from '../common/dto/api-exception';
import type {
  Alert,
  AlertCategory,
  AlertSeverity,
  AlertType,
  MonitorWatch,
} from '../contracts';
import type { Database } from '../db/database';
import { alerts } from '../db/schema';
import type { AlertDraft } from './alert-draft';

/** The inbox is one long list in the UI (filtering happens in the browser), so cap what a single request can pull. */
const LIST_LIMIT = 500;

type AlertRow = InferSelectModel<typeof alerts>;

// `type`, `severity` and `category` are only ever written by monitoring, so narrowing the text columns is safe.
export const toAlert = (row: AlertRow): Alert => ({
  id: row.id,
  type: row.type as AlertType,
  severity: row.severity as AlertSeverity,
  category: row.category as AlertCategory,
  target: row.target,
  message: row.message,
  createdAt: row.createdAt.toISOString(),
  read: row.read,
  ...(row.monitorId ? { monitorId: row.monitorId } : {}),
});

/** What the monitors list needs to know about a monitor's alerts. */
export interface MonitorInsight {
  /** Alerts per kind of change over the window. */
  changes: Record<MonitorWatch, number>;
  /** Unread alerts about changes — failures aren't "changes detected". */
  unreadChanges: number;
  last?: { summary: string; at: string };
}

export const emptyChanges = (): Record<MonitorWatch, number> => ({
  dns: 0,
  ip: 0,
  provider: 0,
  security: 0,
});

@Injectable()
export class AlertsService {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  async list(userId: string): Promise<Alert[]> {
    const rows = await this.db
      .select()
      .from(alerts)
      .where(eq(alerts.userId, userId))
      .orderBy(desc(alerts.createdAt), asc(alerts.id))
      .limit(LIST_LIMIT);
    return rows.map(toAlert);
  }

  async recent(userId: string, limit: number): Promise<Alert[]> {
    const rows = await this.db
      .select()
      .from(alerts)
      .where(eq(alerts.userId, userId))
      .orderBy(desc(alerts.createdAt), asc(alerts.id))
      .limit(limit);
    return rows.map(toAlert);
  }

  async unreadCount(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(alerts)
      .where(and(eq(alerts.userId, userId), eq(alerts.read, false)));
    return row?.count ?? 0;
  }

  /** Scoped to `userId`: someone else's alert id is indistinguishable from a missing one. */
  async setRead(userId: string, id: string, read: boolean): Promise<Alert> {
    const [row] = await this.db
      .update(alerts)
      .set({ read })
      .where(and(eq(alerts.id, id), eq(alerts.userId, userId)))
      .returning();
    if (!row) {
      throw new ApiException('NOT_FOUND', 'That alert was not found.');
    }
    return toAlert(row);
  }

  async markAllRead(userId: string): Promise<void> {
    await this.db
      .update(alerts)
      .set({ read: true })
      .where(and(eq(alerts.userId, userId), eq(alerts.read, false)));
  }

  async create(
    userId: string,
    monitor: { id: string; target: string },
    drafts: AlertDraft[],
    now: Date,
  ): Promise<Alert[]> {
    if (drafts.length === 0) {
      return [];
    }

    const rows = await this.db
      .insert(alerts)
      .values(
        drafts.map((draft) => ({
          userId,
          monitorId: monitor.id,
          target: monitor.target,
          type: draft.type,
          severity: draft.severity,
          category: draft.category,
          message: draft.message,
          summary: draft.summary,
          watch: draft.watch,
          createdAt: now,
        })),
      )
      .returning();
    return rows.map(toAlert);
  }

  /**
   * Per-monitor figures for the monitors page. `since` is passed to SQL as ISO text cast to `timestamp`
   * because the column is a UTC wall-clock `timestamp without time zone`, and a bare Date would be
   * serialised in the server's local zone.
   */
  async monitorInsights(
    userId: string,
    since: Date,
  ): Promise<Map<string, MonitorInsight>> {
    const from = since.toISOString();
    const inWindow = (watch: MonitorWatch) =>
      sql<number>`count(*) filter (where ${alerts.watch} = ${watch} and ${alerts.createdAt} >= ${from}::timestamp)::int`;

    const [counts, latest] = await Promise.all([
      this.db
        .select({
          monitorId: alerts.monitorId,
          dns: inWindow('dns'),
          ip: inWindow('ip'),
          provider: inWindow('provider'),
          security: inWindow('security'),
          unreadChanges: sql<number>`count(*) filter (where not ${alerts.read} and ${alerts.type} <> 'monitor_failed')::int`,
        })
        .from(alerts)
        .where(and(eq(alerts.userId, userId), isNotNull(alerts.monitorId)))
        .groupBy(alerts.monitorId),
      this.db
        .selectDistinctOn([alerts.monitorId], {
          monitorId: alerts.monitorId,
          summary: alerts.summary,
          at: alerts.createdAt,
        })
        .from(alerts)
        .where(and(eq(alerts.userId, userId), isNotNull(alerts.monitorId)))
        .orderBy(alerts.monitorId, desc(alerts.createdAt)),
    ]);

    const insights = new Map<string, MonitorInsight>();
    for (const row of counts) {
      if (row.monitorId) {
        insights.set(row.monitorId, {
          changes: {
            dns: row.dns,
            ip: row.ip,
            provider: row.provider,
            security: row.security,
          },
          unreadChanges: row.unreadChanges,
        });
      }
    }
    for (const row of latest) {
      const insight = row.monitorId ? insights.get(row.monitorId) : undefined;
      if (insight) {
        insight.last = { summary: row.summary, at: row.at.toISOString() };
      }
    }
    return insights;
  }
}
