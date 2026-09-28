import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, sql } from 'drizzle-orm';
import { AlertsService } from '../alerts/alerts.service';
import { canAccess, tierOf } from '../common/features';
import type { DashboardSummary, User } from '../contracts';
import type { Database } from '../db/database';
import { monitors } from '../db/schema';
import { HistoryService } from '../history/history.service';

const RECENT_CHECKS = 5;
const RECENT_ALERTS = 4;

@Injectable()
export class DashboardService {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly history: HistoryService,
    private readonly alerts: AlertsService,
  ) {}

  async summary(user: User): Promise<DashboardSummary> {
    // Monitoring and alerts are Pro features. Someone who has since dropped to Free may still own old rows,
    // but the dashboard shows the locked state, so it gets no numbers.
    const monitoring = canAccess(tierOf(user), 'alerts');

    const [recentChecks, activeMonitors, recentAlerts, unreadAlerts] =
      await Promise.all([
        this.history.recent(user.id, RECENT_CHECKS),
        monitoring ? this.activeMonitors(user.id) : 0,
        monitoring ? this.alerts.recent(user.id, RECENT_ALERTS) : [],
        monitoring ? this.alerts.unreadCount(user.id) : 0,
      ]);

    return { recentChecks, recentAlerts, activeMonitors, unreadAlerts };
  }

  private async activeMonitors(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(monitors)
      .where(and(eq(monitors.userId, userId), eq(monitors.enabled, true)));
    return row?.count ?? 0;
  }
}
