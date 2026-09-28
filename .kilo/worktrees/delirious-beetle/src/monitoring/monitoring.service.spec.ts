import type { AlertsService, MonitorInsight } from '../alerts/alerts.service';
import { ApiException } from '../common/dto/api-exception';
import type { Plan, User } from '../contracts';
import type { CreateMonitorDto } from './dto/monitoring.dto';
import type { MonitorRunner } from './monitor-runner.service';
import type {
  CreateOutcome,
  MonitorRow,
  MonitorStore,
} from './monitor-store.service';
import {
  MonitoringService,
  toRule,
  upgradeForMonitors,
} from './monitoring.service';

const AT = new Date('2026-09-24T12:00:00.000Z');

const row = (overrides: Partial<MonitorRow> = {}): MonitorRow => ({
  id: 'mon_1',
  userId: 'u_1',
  target: 'example.com',
  targetType: 'domain',
  intervalMinutes: 15,
  watch: ['dns', 'ip'],
  enabled: true,
  status: 'healthy',
  consecutiveFailures: 0,
  lastResult: null,
  lastCheckedAt: AT,
  nextCheckAt: new Date(AT.getTime() + 15 * 60_000),
  lastEmailedAt: null,
  createdAt: AT,
  ...overrides,
});

const insight = (overrides: Partial<MonitorInsight> = {}): MonitorInsight => ({
  changes: { dns: 0, ip: 0, provider: 0, security: 0 },
  unreadChanges: 0,
  ...overrides,
});

const user = (plan: Plan = 'pro'): User =>
  ({
    id: 'u_1',
    plan,
    effectivePlan: plan,
    email: 'alex@example.com',
  }) as unknown as User;

const dto = (overrides: Partial<CreateMonitorDto> = {}): CreateMonitorDto => ({
  target: 'https://Example.com/path',
  intervalMinutes: 15,
  watch: ['dns', 'ip'],
  ...overrides,
});

describe('toRule', () => {
  it('is healthy by default', () => {
    expect(toRule(row()).status).toBe('healthy');
  });

  it('is paused whenever it is switched off, whatever else is true', () => {
    expect(
      toRule(
        row({ enabled: false, status: 'failing' }),
        insight({ unreadChanges: 2 }),
      ).status,
    ).toBe('paused');
  });

  it('is failing when the last runs could not read the target, even with unread changes', () => {
    expect(
      toRule(row({ status: 'failing' }), insight({ unreadChanges: 2 })).status,
    ).toBe('failing');
  });

  it('shows "changed" while there are unread change alerts, and clears once they are read', () => {
    expect(toRule(row(), insight({ unreadChanges: 1 })).status).toBe('changed');
    expect(toRule(row(), insight({ unreadChanges: 0 })).status).toBe('healthy');
  });

  it('carries the 30-day counts and the latest change', () => {
    const rule = toRule(
      row(),
      insight({
        changes: { dns: 1, ip: 2, provider: 0, security: 0 },
        last: { summary: 'New address: 1.1.1.1.', at: AT.toISOString() },
      }),
    );

    expect(rule.changes).toEqual({ dns: 1, ip: 2, provider: 0, security: 0 });
    expect(rule.lastChange).toEqual({
      summary: 'New address: 1.1.1.1.',
      at: AT.toISOString(),
    });
  });

  it('has no schedule while paused, zero counts and no lastChange when nothing happened', () => {
    const rule = toRule(row({ enabled: false }));

    expect(rule.nextCheckAt).toBeNull();
    expect(rule.changes).toEqual({ dns: 0, ip: 0, provider: 0, security: 0 });
    expect(rule).not.toHaveProperty('lastChange');
  });

  it('reports "never checked" as null', () => {
    expect(toRule(row({ lastCheckedAt: null })).lastCheckedAt).toBeNull();
  });
});

describe('upgradeForMonitors', () => {
  it('points each plan at the next one that allows more', () => {
    expect(upgradeForMonitors('free')).toBe('pro');
    expect(upgradeForMonitors('pro')).toBe('business');
    expect(upgradeForMonitors('business')).toBe('enterprise');
  });

  it('has nowhere to send an unlimited plan', () => {
    expect(upgradeForMonitors('enterprise')).toBeUndefined();
  });
});

const setup = (outcome?: CreateOutcome) => {
  const store = {
    list: jest.fn((): Promise<MonitorRow[]> => Promise.resolve([row()])),
    find: jest.fn((): Promise<MonitorRow | undefined> =>
      Promise.resolve(row()),
    ),
    create: jest.fn((): Promise<CreateOutcome> =>
      Promise.resolve(outcome ?? { status: 'created', monitor: row() }),
    ),
    setEnabled: jest.fn((): Promise<MonitorRow | undefined> =>
      Promise.resolve(row({ enabled: false })),
    ),
    remove: jest.fn((): Promise<boolean> => Promise.resolve(true)),
  };
  const runner = { run: jest.fn((): Promise<void> => Promise.resolve()) };
  const alerts = {
    monitorInsights: jest.fn((): Promise<Map<string, MonitorInsight>> =>
      Promise.resolve(new Map([['mon_1', insight({ unreadChanges: 1 })]])),
    ),
  };
  const service = new MonitoringService(
    store as unknown as MonitorStore,
    runner as unknown as MonitorRunner,
    alerts as unknown as AlertsService,
  );
  return { service, store, runner, alerts };
};

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as ApiException;
  }
  throw new Error('expected a rejection');
};

describe('MonitoringService.list', () => {
  it('returns the rules with their derived status and the plan limit', async () => {
    const { service } = setup();

    const overview = await service.list(user('pro'));

    expect(overview.limit).toBe(5);
    expect(overview.rules).toHaveLength(1);
    expect(overview.rules[0]).toMatchObject({ id: 'mon_1', status: 'changed' });
  });

  it('reports no limit for an unlimited plan', async () => {
    const { service } = setup();
    expect((await service.list(user('enterprise'))).limit).toBeNull();
  });
});

describe('MonitoringService.create', () => {
  it('normalises the target, stores the monitor, runs it once and returns it', async () => {
    const { service, store, runner } = setup();

    const rule = await service.create(user('pro'), dto());

    expect(store.create).toHaveBeenCalledWith(
      'u_1',
      {
        target: 'example.com',
        targetType: 'domain',
        intervalMinutes: 15,
        watch: ['dns', 'ip'],
      },
      5,
      expect.any(Date),
    );
    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'mon_1' }),
    );
    expect(rule.id).toBe('mon_1');
  });

  it('accepts an IP address', async () => {
    const { service, store } = setup();

    await service.create(user('pro'), dto({ target: '1.1.1.1' }));

    expect(store.create).toHaveBeenCalledWith(
      'u_1',
      expect.objectContaining({ target: '1.1.1.1', targetType: 'ipv4' }),
      5,
      expect.any(Date),
    );
  });

  it('rejects a target that is not a public domain or IP, without touching the database', async () => {
    const { service, store } = setup();

    for (const target of ['', 'not a domain', '10.0.0.1', 'localhost']) {
      const error = await errorOf(service.create(user('pro'), dto({ target })));
      expect(error.code).toBe('INVALID_INPUT');
    }
    expect(store.create).not.toHaveBeenCalled();
  });

  it('answers CONFLICT when the target is already monitored', async () => {
    const { service, runner } = setup({ status: 'exists' });

    const error = await errorOf(service.create(user('pro'), dto()));

    expect(error.code).toBe('CONFLICT');
    expect(error.message).toContain('example.com');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('answers PLAN_REQUIRED at the limit, pointing at the plan that allows more', async () => {
    const { service, runner } = setup({ status: 'limit' });

    const error = await errorOf(service.create(user('pro'), dto()));

    expect(error.code).toBe('PLAN_REQUIRED');
    expect(error.message).toBe(
      "You've reached your plan's limit of 5 monitors.",
    );
    expect(error.details).toEqual({ requiredPlan: 'business' });
    expect(runner.run).not.toHaveBeenCalled();
  });
});

describe('MonitoringService.setEnabled / runNow / remove', () => {
  it('pauses and returns the monitor', async () => {
    const { service, store } = setup();

    const rule = await service.setEnabled(user(), 'mon_1', false);

    expect(store.setEnabled).toHaveBeenCalledWith(
      'u_1',
      'mon_1',
      false,
      expect.any(Date),
    );
    expect(rule.status).toBe('paused');
  });

  it('answers NOT_FOUND for a monitor that is missing or someone else’s', async () => {
    const { service, store } = setup();
    store.setEnabled.mockResolvedValueOnce(undefined);
    store.find.mockResolvedValueOnce(undefined);
    store.remove.mockResolvedValueOnce(false);

    expect((await errorOf(service.setEnabled(user(), 'x', true))).code).toBe(
      'NOT_FOUND',
    );
    expect((await errorOf(service.runNow(user(), 'x'))).code).toBe('NOT_FOUND');
    expect((await errorOf(service.remove(user(), 'x'))).code).toBe('NOT_FOUND');
  });

  it('runs an active monitor now', async () => {
    const { service, runner } = setup();

    await service.runNow(user(), 'mon_1');

    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'mon_1' }),
    );
  });

  it('refuses to run a paused monitor', async () => {
    const { service, store, runner } = setup();
    store.find.mockResolvedValueOnce(row({ enabled: false }));

    const error = await errorOf(service.runNow(user(), 'mon_1'));

    expect(error.code).toBe('CONFLICT');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('deletes a monitor', async () => {
    const { service, store } = setup();
    await service.remove(user(), 'mon_1');
    expect(store.remove).toHaveBeenCalledWith('u_1', 'mon_1');
  });
});
