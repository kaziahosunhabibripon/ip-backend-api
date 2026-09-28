import type { ConfigService } from '@nestjs/config';
import type { AlertMailService } from '../alerts/alert-mail.service';
import type { AlertsService } from '../alerts/alerts.service';
import { ApiException } from '../common/dto/api-exception';
import type { Alert, DomainCheckResult, MonitorWatch } from '../contracts';
import type { LookupService } from '../lookup/lookup.service';
import type { TeamsService } from '../teams/teams.service';
import type { UsersService } from '../users/users.service';
import { checkResult, type FixtureOptions } from './check-result.fixture-spec';
import { FAILURE_THRESHOLD, MonitorRunner } from './monitor-runner.service';
import type { MonitorRow, MonitorStore } from './monitor-store.service';
import { buildSnapshot } from './snapshot';

const NOW = Date.now();
const MINUTE = 60_000;

const owner = {
  id: 'u_1',
  name: 'Alex',
  email: 'alex@example.com',
  passwordHash: 'scrypt$hash',
  plan: 'pro' as const,
  role: 'user' as const,
  emailVerified: true,
  notificationPreferences: {
    monitorAlerts: true,
    securityAlerts: true,
    weeklyDigest: false,
    usageWarnings: true,
    productUpdates: false,
  },
  createdAt: new Date(NOW - 86_400_000),
  suspendedAt: null,
  suspensionReason: null,
};

const stable: FixtureOptions = {
  addresses: [{ ip: '1.1.1.1' }, { ip: '2.2.2.2' }],
  advanced: [{ type: 'NS', name: 'example.com', value: 'ns1.example.net' }],
};
const moved: FixtureOptions = {
  ...stable,
  addresses: [{ ip: '8.8.8.8' }, { ip: '9.9.9.9' }],
};

const monitorRow = (overrides: Partial<MonitorRow> = {}): MonitorRow => ({
  id: 'mon_1',
  userId: 'u_1',
  target: 'example.com',
  targetType: 'domain',
  intervalMinutes: 15,
  watch: ['dns', 'ip', 'provider', 'security'],
  enabled: true,
  status: 'healthy',
  consecutiveFailures: 0,
  lastResult: buildSnapshot(checkResult(stable), null),
  lastCheckedAt: new Date(NOW - 15 * MINUTE),
  nextCheckAt: new Date(NOW),
  lastEmailedAt: null,
  createdAt: new Date(NOW - 86_400_000),
  ...overrides,
});

const setup = (
  options: {
    ownerPlan?: 'free' | 'pro' | 'business' | 'enterprise';
    teamPlan?: 'free' | 'pro' | 'business' | 'enterprise';
    ownerFound?: boolean;
  } = {},
) => {
  const store = {
    recordRun: jest.fn((): Promise<boolean> => Promise.resolve(true)),
    postpone: jest.fn((): Promise<void> => Promise.resolve()),
    markEmailed: jest.fn((): Promise<void> => Promise.resolve()),
  };
  const inspect = jest.fn((): Promise<DomainCheckResult> =>
    Promise.resolve(checkResult(stable)),
  );
  const lookup = { inspect };
  const alerts = {
    create: jest.fn(
      (
        userId: string,
        monitor: { id: string; target: string },
        drafts: {
          type: Alert['type'];
          severity: Alert['severity'];
          category: Alert['category'];
          message: string;
        }[],
        at: Date,
      ): Promise<Alert[]> =>
        Promise.resolve(
          drafts.map((draft, index) => ({
            id: `alt_${index}`,
            type: draft.type,
            severity: draft.severity,
            category: draft.category,
            target: monitor.target,
            message: draft.message,
            createdAt: at.toISOString(),
            read: false,
            monitorId: monitor.id,
          })),
        ),
    ),
  };
  const mail = {
    notify: jest.fn((): Promise<boolean> => Promise.resolve(true)),
  };
  const users = {
    findById: jest.fn(() =>
      Promise.resolve(
        options.ownerFound === false
          ? undefined
          : { ...owner, plan: options.ownerPlan ?? owner.plan },
      ),
    ),
  };
  const teams = {
    effectivePlan: jest.fn((user: { plan: string }) =>
      Promise.resolve(options.teamPlan ?? user.plan),
    ),
  };
  const config = {
    get: (key: string) =>
      key === 'MONITORING_CONFIRM_DELAY_MS' ? '0' : undefined,
  };

  const runner = new MonitorRunner(
    store as unknown as MonitorStore,
    lookup as unknown as LookupService,
    alerts as unknown as AlertsService,
    mail as unknown as AlertMailService,
    users as unknown as UsersService,
    teams as unknown as TeamsService,
    config as unknown as ConfigService,
  );
  return { runner, store, inspect, alerts, mail, users, teams };
};

const withResults = (
  inspect: jest.Mock,
  ...outcomes: (FixtureOptions | Error)[]
) => {
  for (const outcome of outcomes) {
    if (outcome instanceof Error) {
      inspect.mockRejectedValueOnce(outcome);
    } else {
      inspect.mockResolvedValueOnce(checkResult(outcome));
    }
  }
};

const down = () => new ApiException('DNS_TIMEOUT', 'DNS resolution timed out.');

describe('MonitorRunner — a quiet run', () => {
  it('records the first good look as a baseline without alerting', async () => {
    const { runner, store, alerts, mail } = setup();

    await runner.run(monitorRow({ lastResult: null }));

    expect(alerts.create).not.toHaveBeenCalled();
    expect(mail.notify).not.toHaveBeenCalled();
    expect(store.recordRun).toHaveBeenCalledWith(
      'mon_1',
      expect.objectContaining({
        snapshot: expect.objectContaining({
          addresses: ['1.1.1.1', '2.2.2.2'],
        }),
        status: 'healthy',
        consecutiveFailures: 0,
      }),
    );
  });

  it('schedules the next run one interval after the run finished', async () => {
    const { runner, store } = setup();

    await runner.run(monitorRow({ intervalMinutes: 60 }));

    const record = (
      store.recordRun.mock.calls as unknown as [
        string,
        { lastCheckedAt: Date; nextCheckAt: Date },
      ][]
    )[0][1];
    expect(record.nextCheckAt.getTime() - record.lastCheckedAt.getTime()).toBe(
      60 * MINUTE,
    );
  });

  it('does not alert when only TTLs differ from the last look', async () => {
    const { runner, inspect, alerts } = setup();
    withResults(inspect, { ...stable, ttl: 17 });

    await runner.run(monitorRow());

    expect(alerts.create).not.toHaveBeenCalled();
  });
});

describe('MonitorRunner — a change', () => {
  it('alerts, emails and adopts the new look once a second look agrees', async () => {
    const { runner, inspect, alerts, mail, store } = setup();
    withResults(inspect, moved, moved);

    await runner.run(monitorRow());

    expect(inspect).toHaveBeenCalledTimes(2);
    expect(alerts.create).toHaveBeenCalledWith(
      'u_1',
      expect.objectContaining({ id: 'mon_1', target: 'example.com' }),
      [expect.objectContaining({ type: 'ip_changed', severity: 'high' })],
      expect.any(Date),
    );
    expect(mail.notify).toHaveBeenCalledWith(
      owner,
      [expect.objectContaining({ type: 'ip_changed' })],
      null,
      expect.any(Date),
    );
    expect(store.markEmailed).toHaveBeenCalledWith('mon_1', expect.any(Date));
    expect(store.recordRun).toHaveBeenCalledWith(
      'mon_1',
      expect.objectContaining({
        snapshot: expect.objectContaining({
          addresses: ['8.8.8.8', '9.9.9.9'],
        }),
      }),
    );
  });

  it('stays quiet when the second look shows it was a blip', async () => {
    const { runner, inspect, alerts, mail } = setup();
    withResults(inspect, moved, stable);

    await runner.run(monitorRow());

    expect(alerts.create).not.toHaveBeenCalled();
    expect(mail.notify).not.toHaveBeenCalled();
  });

  it('keeps the old baseline when the confirming look fails, so the next run judges the change again', async () => {
    const { runner, inspect, alerts, store } = setup();
    withResults(inspect, moved, down());

    await runner.run(monitorRow());

    expect(alerts.create).not.toHaveBeenCalled();
    expect(store.recordRun).toHaveBeenCalledWith(
      'mon_1',
      expect.not.objectContaining({ snapshot: expect.anything() }),
    );
    // The first look worked, so this is not counted as a failure.
    expect(store.recordRun).toHaveBeenCalledWith(
      'mon_1',
      expect.objectContaining({ status: 'healthy', consecutiveFailures: 0 }),
    );
  });

  it('only alerts for the kinds of change the monitor watches', async () => {
    const { runner, inspect, alerts } = setup();
    withResults(inspect, moved, moved);

    await runner.run(monitorRow({ watch: ['dns'] as MonitorWatch[] }));

    expect(alerts.create).not.toHaveBeenCalled();
  });

  it('does not read a provider outage as a change', async () => {
    const { runner, inspect, alerts } = setup();
    // MX/NS lookup failed, the security reading is missing: neither may look like "removed".
    withResults(inspect, {
      addresses: [
        { ip: '1.1.1.1', security: 'unavailable' },
        { ip: '2.2.2.2', security: 'unavailable' },
      ],
      advanced: 'failed',
    });

    await runner.run(monitorRow());

    expect(alerts.create).not.toHaveBeenCalled();
  });

  it('holds the alert back from the email when the alert could not be saved, and retries next run', async () => {
    const { runner, inspect, alerts, store, mail } = setup();
    withResults(inspect, moved, moved);
    alerts.create.mockRejectedValueOnce(new Error('db down'));

    await expect(runner.run(monitorRow())).rejects.toThrow('db down');

    expect(store.recordRun).not.toHaveBeenCalled(); // baseline untouched
    expect(mail.notify).not.toHaveBeenCalled();
  });

  it('does not email when the monitor was deleted while it ran', async () => {
    const { runner, inspect, store, mail } = setup();
    withResults(inspect, moved, moved);
    store.recordRun.mockResolvedValueOnce(false);

    await runner.run(monitorRow());

    expect(mail.notify).not.toHaveBeenCalled();
  });

  it('does not start the cooldown when no email went out', async () => {
    const { runner, inspect, mail, store } = setup();
    withResults(inspect, moved, moved);
    mail.notify.mockResolvedValueOnce(false);

    await runner.run(monitorRow());

    expect(store.markEmailed).not.toHaveBeenCalled();
  });

  it('passes the previous email time to the mailer so it can apply the cooldown', async () => {
    const { runner, inspect, mail } = setup();
    withResults(inspect, moved, moved);
    const lastEmailedAt = new Date(NOW - 5 * MINUTE);

    await runner.run(monitorRow({ lastEmailedAt }));

    expect(mail.notify).toHaveBeenCalledWith(
      owner,
      expect.any(Array),
      lastEmailedAt,
      expect.any(Date),
    );
  });

  it('survives a mail failure: the alert is already saved', async () => {
    const { runner, inspect, mail, store } = setup();
    withResults(inspect, moved, moved);
    mail.notify.mockRejectedValueOnce(new Error('smtp down'));

    await expect(runner.run(monitorRow())).resolves.toBeUndefined();
    expect(store.markEmailed).not.toHaveBeenCalled();
  });
});

describe('MonitorRunner — runs that cannot read the target', () => {
  it('counts the failure without alerting and retries within minutes, not a whole day later', async () => {
    const { runner, inspect, alerts, store } = setup();
    withResults(inspect, down());

    await runner.run(monitorRow({ intervalMinutes: 1440 }));

    expect(alerts.create).not.toHaveBeenCalled();
    const record = (
      store.recordRun.mock.calls as unknown as [
        string,
        {
          status: string;
          consecutiveFailures: number;
          lastCheckedAt: Date;
          nextCheckAt: Date;
        },
      ][]
    )[0][1];
    expect(record.status).toBe('healthy');
    expect(record.consecutiveFailures).toBe(1);
    expect(record.nextCheckAt.getTime() - record.lastCheckedAt.getTime()).toBe(
      5 * MINUTE,
    );
    expect(store.recordRun).toHaveBeenCalledWith(
      'mon_1',
      expect.not.objectContaining({ snapshot: expect.anything() }),
    );
  });

  it('marks the monitor failing on the third failure in a row, with one alert and an email', async () => {
    const { runner, inspect, alerts, mail, store } = setup();
    withResults(inspect, down());

    await runner.run(
      monitorRow({ consecutiveFailures: FAILURE_THRESHOLD - 1 }),
    );

    expect(alerts.create).toHaveBeenCalledWith(
      'u_1',
      expect.objectContaining({ id: 'mon_1' }),
      [
        expect.objectContaining({
          type: 'monitor_failed',
          severity: 'high',
          category: 'network',
          watch: null,
          message: expect.stringContaining('3 times in a row'),
        }),
      ],
      expect.any(Date),
    );
    expect(store.recordRun).toHaveBeenCalledWith(
      'mon_1',
      expect.objectContaining({ status: 'failing', consecutiveFailures: 3 }),
    );
    expect(mail.notify).toHaveBeenCalledTimes(1);
  });

  it('does not alert again while it stays failing, and goes back to its normal interval', async () => {
    const { runner, inspect, alerts, store } = setup();
    withResults(inspect, down());

    await runner.run(
      monitorRow({
        status: 'failing',
        consecutiveFailures: 7,
        intervalMinutes: 60,
      }),
    );

    expect(alerts.create).not.toHaveBeenCalled();
    const record = (
      store.recordRun.mock.calls as unknown as [
        string,
        { lastCheckedAt: Date; nextCheckAt: Date },
      ][]
    )[0][1];
    expect(record.nextCheckAt.getTime() - record.lastCheckedAt.getTime()).toBe(
      60 * MINUTE,
    );
  });

  it('treats a SERVFAIL as a failed run, not as every record disappearing', async () => {
    const { runner, inspect, alerts, store } = setup();
    withResults(inspect, { addresses: [], dnsStatus: 'servfail' });

    await runner.run(monitorRow());

    expect(alerts.create).not.toHaveBeenCalled();
    expect(store.recordRun).toHaveBeenCalledWith(
      'mon_1',
      expect.objectContaining({ consecutiveFailures: 1 }),
    );
  });

  it('recovers on the next good look: failures reset and status healthy', async () => {
    const { runner, store, alerts } = setup();

    await runner.run(monitorRow({ status: 'failing', consecutiveFailures: 4 }));

    expect(alerts.create).not.toHaveBeenCalled();
    expect(store.recordRun).toHaveBeenCalledWith(
      'mon_1',
      expect.objectContaining({ status: 'healthy', consecutiveFailures: 0 }),
    );
  });
});

describe('MonitorRunner — overlapping requests', () => {
  it('runs a monitor once when it is asked for twice at the same time', async () => {
    const { runner, inspect } = setup();
    const row = monitorRow();

    await Promise.all([runner.run(row), runner.run(row)]);

    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('runs it again once the first run is over', async () => {
    const { runner, inspect } = setup();
    const row = monitorRow();

    await runner.run(row);
    await runner.run(row);

    expect(inspect).toHaveBeenCalledTimes(2);
  });
});

describe('MonitorRunner — entitlement, checked fresh on every run', () => {
  it('waits out its interval without looking, alerting or touching the failure count, once the owner’s plan (own or team) no longer includes monitoring', async () => {
    const { runner, store, inspect, alerts, mail } = setup({
      ownerPlan: 'free',
    });
    const row = monitorRow({ consecutiveFailures: 1, status: 'healthy' });

    await runner.run(row);

    expect(inspect).not.toHaveBeenCalled();
    expect(alerts.create).not.toHaveBeenCalled();
    expect(mail.notify).not.toHaveBeenCalled();
    expect(store.recordRun).not.toHaveBeenCalled();
    expect(store.postpone).toHaveBeenCalledWith('mon_1', expect.any(Date));
    const [, nextCheckAt] = (store.postpone as jest.Mock).mock.calls[0] as [
      string,
      Date,
    ];
    expect(nextCheckAt.getTime()).toBeGreaterThan(
      Date.now() + (row.intervalMinutes - 1) * MINUTE,
    );
  });

  it('runs normally for a Free owner riding a team’s plan', async () => {
    const { runner, inspect } = setup({
      ownerPlan: 'free',
      teamPlan: 'business',
    });

    await runner.run(monitorRow({ lastResult: null }));

    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('waits, rather than throws, when the owner’s account no longer exists', async () => {
    const { runner, store, inspect } = setup({ ownerFound: false });

    await runner.run(monitorRow());

    expect(inspect).not.toHaveBeenCalled();
    expect(store.postpone).toHaveBeenCalled();
  });
});
