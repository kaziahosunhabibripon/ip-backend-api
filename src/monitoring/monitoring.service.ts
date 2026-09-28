import { Injectable } from '@nestjs/common';
import {
  emptyChanges,
  AlertsService,
  type MonitorInsight,
} from '../alerts/alerts.service';
import { ApiException } from '../common/dto/api-exception';
import { PLAN_LIMITS, PLAN_ORDER } from '../common/plans';
import type {
  InputType,
  MonitoringOverview,
  MonitoringRule,
  MonitorStatus,
  Plan,
  User,
} from '../contracts';
import { normalizeTarget } from '../lookup/normalizer/target-normalizer';
import type { CreateMonitorDto } from './dto/monitoring.dto';
import { MonitorRunner } from './monitor-runner.service';
import { MonitorStore, type MonitorRow } from './monitor-store.service';

const DAY_MS = 24 * 60 * 60 * 1000;
/** "Changes in the last 30 days" on the monitors page. */
const CHANGE_WINDOW_DAYS = 30;

/**
 * What the site shows for a monitor. "Paused" and "changed" are worked out here rather than stored:
 * paused is simply `enabled = false`, and changed means there are change alerts the user hasn't read
 * yet — so reading them (or marking all read) settles it, with nothing to keep in sync.
 */
export const toRule = (
  row: MonitorRow,
  insight?: MonitorInsight,
): MonitoringRule => {
  let status: MonitorStatus = 'healthy';
  if (!row.enabled) {
    status = 'paused';
  } else if (row.status === 'failing') {
    status = 'failing';
  } else if ((insight?.unreadChanges ?? 0) > 0) {
    status = 'changed';
  }

  return {
    id: row.id,
    target: row.target,
    // Written only by this service from a normalised target.
    targetType: row.targetType as InputType,
    status,
    intervalMinutes: row.intervalMinutes,
    enabled: row.enabled,
    watch: row.watch,
    createdAt: row.createdAt.toISOString(),
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    nextCheckAt:
      row.enabled && row.nextCheckAt ? row.nextCheckAt.toISOString() : null,
    changes: insight?.changes ?? emptyChanges(),
    ...(insight?.last ? { lastChange: insight.last } : {}),
  };
};

/** The next plan up that allows more monitors than `plan` does — what a user at their limit should look at. */
export const upgradeForMonitors = (plan: Plan): Plan | undefined => {
  const current = PLAN_LIMITS[plan].monitors;
  return PLAN_ORDER.find((candidate) => {
    const limit = PLAN_LIMITS[candidate].monitors;
    return current !== null && (limit === null || limit > current);
  });
};

@Injectable()
export class MonitoringService {
  constructor(
    private readonly store: MonitorStore,
    private readonly runner: MonitorRunner,
    private readonly alerts: AlertsService,
  ) {}

  async list(user: User): Promise<MonitoringOverview> {
    const [rows, insights] = await Promise.all([
      this.store.list(user.id),
      this.insights(user.id),
    ]);
    return {
      rules: rows.map((row) => toRule(row, insights.get(row.id))),
      limit: PLAN_LIMITS[user.effectivePlan].monitors,
    };
  }

  /**
   * Creates the monitor and runs it once straight away, so the response already carries a first
   * "last checked" and the baseline exists. A first run that can't read the target still leaves the
   * monitor in place: it counts as a failed run and is retried in a few minutes.
   */
  async create(user: User, dto: CreateMonitorDto): Promise<MonitoringRule> {
    const normalized = normalizeTarget(dto.target);
    if (!normalized.ok) {
      throw new ApiException('INVALID_INPUT', normalized.title, {
        reason: normalized.reason,
        hint: normalized.message,
      });
    }

    const outcome = await this.store.create(
      user.id,
      {
        target: normalized.value,
        targetType: normalized.type,
        intervalMinutes: dto.intervalMinutes,
        watch: dto.watch,
      },
      PLAN_LIMITS[user.effectivePlan].monitors,
      new Date(),
    );

    if (outcome.status === 'exists') {
      throw new ApiException(
        'CONFLICT',
        `You're already monitoring ${normalized.value}.`,
      );
    }
    if (outcome.status === 'limit') {
      const limit = PLAN_LIMITS[user.effectivePlan].monitors;
      const upgrade = upgradeForMonitors(user.effectivePlan);
      throw new ApiException(
        'PLAN_REQUIRED',
        `You've reached your plan's limit of ${limit} monitors.`,
        upgrade ? { requiredPlan: upgrade } : undefined,
      );
    }

    await this.runner.run(outcome.monitor);
    return this.rule(user.id, outcome.monitor.id);
  }

  async setEnabled(
    user: User,
    id: string,
    enabled: boolean,
  ): Promise<MonitoringRule> {
    const row = await this.store.setEnabled(user.id, id, enabled, new Date());
    if (!row) {
      throw this.notFound();
    }
    const insights = await this.insights(user.id);
    return toRule(row, insights.get(row.id));
  }

  /** Runs the monitor now and returns it as it stands afterwards. */
  async runNow(user: User, id: string): Promise<MonitoringRule> {
    const row = await this.store.find(user.id, id);
    if (!row) {
      throw this.notFound();
    }
    if (!row.enabled) {
      throw new ApiException(
        'CONFLICT',
        'This monitor is paused. Resume it before running a check.',
      );
    }

    await this.runner.run(row);
    return this.rule(user.id, row.id);
  }

  /** The monitor's alerts stay in the inbox (they hold their own copy of the target). */
  async remove(user: User, id: string): Promise<void> {
    if (!(await this.store.remove(user.id, id))) {
      throw this.notFound();
    }
  }

  private insights(userId: string) {
    return this.alerts.monitorInsights(
      userId,
      new Date(Date.now() - CHANGE_WINDOW_DAYS * DAY_MS),
    );
  }

  private async rule(userId: string, id: string): Promise<MonitoringRule> {
    const [row, insights] = await Promise.all([
      this.store.find(userId, id),
      this.insights(userId),
    ]);
    if (!row) {
      // Deleted while the run was in flight.
      throw this.notFound();
    }
    return toRule(row, insights.get(id));
  }

  private notFound() {
    return new ApiException('NOT_FOUND', 'That monitor was not found.');
  }
}
