import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AlertDraft } from '../alerts/alert-draft';
import { AlertMailService } from '../alerts/alert-mail.service';
import { AlertsService } from '../alerts/alerts.service';
import { canAccess, tierOf } from '../common/features';
import type { Alert, DomainCheckResult, InputType } from '../contracts';
import { LookupService } from '../lookup/lookup.service';
import { TeamsService } from '../teams/teams.service';
import { toUser } from '../users/user.mapper';
import { UsersService } from '../users/users.service';
import {
  confirmedChanges,
  diffSnapshots,
  draftAlerts,
  type Change,
} from './diff';
import { MonitorStore, type MonitorRow } from './monitor-store.service';
import { buildSnapshot, type MonitorSnapshot } from './snapshot';

/** Runs in a row that couldn't read the target before the monitor is called failing. */
export const FAILURE_THRESHOLD = 3;
/** While a monitor is still working towards "failing", retry this soon instead of waiting out a long interval. */
const RETRY_MINUTES = 5;
const MINUTE_MS = 60_000;
const DEFAULT_CONFIRM_DELAY_MS = 3000;

const wait = (ms: number) =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : undefined;

const reasonOf = (error: unknown) =>
  error instanceof Error && error.message
    ? error.message.replace(/\.$/, '')
    : 'the target could not be read';

/**
 * One monitoring run: look at the target, compare with the last good look, and turn what changed into
 * alerts. The rules that keep it trustworthy:
 *
 * - the first good look is only a baseline and never alerts;
 * - a look that could not read the target is a failure, not a change — it never touches the baseline, and
 *   three in a row mark the monitor failing (one alert, when it flips);
 * - a change has to be seen twice, a few seconds apart, before it alerts, so one odd answer from a
 *   resolver can't raise a false alarm;
 * - parts of a look that a provider couldn't deliver this time are carried over from the baseline
 *   (see `buildSnapshot`) instead of being read as "gone".
 */
@Injectable()
export class MonitorRunner {
  private readonly logger = new Logger(MonitorRunner.name);
  private readonly running = new Map<string, Promise<void>>();
  private readonly confirmDelayMs: number;

  constructor(
    private readonly store: MonitorStore,
    private readonly lookup: LookupService,
    private readonly alerts: AlertsService,
    private readonly mail: AlertMailService,
    private readonly users: UsersService,
    private readonly teams: TeamsService,
    config: ConfigService,
  ) {
    const configured = Number(
      config.get<string>('MONITORING_CONFIRM_DELAY_MS'),
    );
    this.confirmDelayMs =
      Number.isFinite(configured) && configured >= 0
        ? configured
        : DEFAULT_CONFIRM_DELAY_MS;
  }

  /** A second call for a monitor that is already running waits for that run instead of starting another. */
  run(monitor: MonitorRow): Promise<void> {
    const inFlight = this.running.get(monitor.id);
    if (inFlight) {
      return inFlight;
    }

    const work = this.execute(monitor).finally(() =>
      this.running.delete(monitor.id),
    );
    this.running.set(monitor.id, work);
    return work;
  }

  private now() {
    return new Date();
  }

  private async look(monitor: MonitorRow): Promise<DomainCheckResult> {
    const result = await this.lookup.inspect(
      monitor.target,
      monitor.targetType as InputType,
    );
    // "The resolver had a bad moment" says nothing about the domain; treating it as data would report every record removed.
    if (result.dns?.status === 'servfail') {
      throw new Error('The resolver answered SERVFAIL');
    }
    return result;
  }

  /**
   * Whether monitoring is still included, checked fresh on every run rather than at claim time: an owner's
   * plan, or the plan a team member currently rides, can change between one run and the next. Not entitled
   * is not a failure — it's simply not looked at yet, so the monitor waits out its own interval and is
   * claimed again without ever touching its failure count or its status.
   */
  private async entitled(monitor: MonitorRow): Promise<boolean> {
    const row = await this.users.findById(monitor.userId);
    if (!row) {
      return false;
    }
    const owner = toUser(row);
    owner.effectivePlan = await this.teams.effectivePlan(owner);
    return canAccess(tierOf(owner), 'monitoring');
  }

  private async execute(monitor: MonitorRow): Promise<void> {
    if (!(await this.entitled(monitor))) {
      await this.store.postpone(
        monitor.id,
        new Date(this.now().getTime() + monitor.intervalMinutes * MINUTE_MS),
      );
      return;
    }

    let result: DomainCheckResult;
    try {
      result = await this.look(monitor);
    } catch (error) {
      await this.recordFailure(monitor, error);
      return;
    }

    const previous = monitor.lastResult ?? null;
    let snapshot: MonitorSnapshot | null = buildSnapshot(result, previous);
    let changes: Change[] = [];

    if (previous) {
      changes = diffSnapshots(previous, snapshot, monitor.watch);
      if (changes.length > 0) {
        ({ changes, snapshot } = await this.confirm(
          monitor,
          previous,
          changes,
        ));
      }
    }

    // Alerts first: if saving them fails, the baseline stays put and the next run finds the change again.
    const at = this.now();
    const created =
      changes.length > 0
        ? await this.alerts.create(
            monitor.userId,
            monitor,
            draftAlerts(changes),
            at,
          )
        : [];

    const recorded = await this.store.recordRun(monitor.id, {
      ...(snapshot ? { snapshot } : {}),
      status: 'healthy',
      consecutiveFailures: 0,
      lastCheckedAt: at,
      nextCheckAt: new Date(at.getTime() + monitor.intervalMinutes * MINUTE_MS),
    });
    if (recorded && created.length > 0) {
      await this.email(monitor, created, at);
    }
  }

  /**
   * Looks again before believing a change. Returns the changes both looks agree on and the newer snapshot
   * to keep. If the second look fails there is nothing to confirm with: no alert now, and the baseline
   * (`null` snapshot) is left alone so the next run judges the change again.
   */
  private async confirm(
    monitor: MonitorRow,
    previous: MonitorSnapshot,
    first: Change[],
  ): Promise<{ changes: Change[]; snapshot: MonitorSnapshot | null }> {
    await wait(this.confirmDelayMs);
    try {
      const second = buildSnapshot(await this.look(monitor), previous);
      const changes = confirmedChanges(
        first,
        diffSnapshots(previous, second, monitor.watch),
      );
      return { changes, snapshot: second };
    } catch (error) {
      this.logger.warn(
        `Could not confirm a change on ${monitor.target}: ${reasonOf(error)}. Keeping the old baseline.`,
      );
      return { changes: [], snapshot: null };
    }
  }

  private async recordFailure(monitor: MonitorRow, error: unknown) {
    const at = this.now();
    const failures = monitor.consecutiveFailures + 1;
    const failing = failures >= FAILURE_THRESHOLD;
    const justFailed = failing && monitor.status !== 'failing';

    let created: Alert[] = [];
    if (justFailed) {
      const draft: AlertDraft = {
        type: 'monitor_failed',
        category: 'network',
        severity: 'high',
        watch: null,
        message: `${monitor.target} could not be checked ${failures} times in a row (${reasonOf(error)}). The monitor is now marked as failing and keeps trying on its schedule.`,
        summary: `Could not be checked ${failures} times in a row`,
      };
      created = await this.alerts.create(monitor.userId, monitor, [draft], at);
    }

    // Until it is officially failing, look again soon rather than after a long interval.
    const retryIn = failing
      ? monitor.intervalMinutes
      : Math.min(monitor.intervalMinutes, RETRY_MINUTES);
    const recorded = await this.store.recordRun(monitor.id, {
      status: failing ? 'failing' : 'healthy',
      consecutiveFailures: failures,
      lastCheckedAt: at,
      nextCheckAt: new Date(at.getTime() + retryIn * MINUTE_MS),
    });
    if (recorded && created.length > 0) {
      await this.email(monitor, created, at);
    }
  }

  /** Best-effort: the alerts are already saved, so a problem here is logged and nothing more. */
  private async email(monitor: MonitorRow, created: Alert[], at: Date) {
    try {
      const owner = await this.users.findById(monitor.userId);
      if (!owner) {
        return;
      }
      const sent = await this.mail.notify(
        owner,
        created,
        monitor.lastEmailedAt,
        at,
      );
      if (sent) {
        await this.store.markEmailed(monitor.id, at);
      }
    } catch (error) {
      this.logger.error(
        `Alert email for ${monitor.target} failed: ${reasonOf(error)}`,
      );
    }
  }
}
