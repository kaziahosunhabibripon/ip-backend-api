import type { ConfigService } from '@nestjs/config';
import type { GatewayClient } from '../billing/gateway.client';
import type { CacheService } from '../cache/cache.service';
import {
  ProviderHealthService,
  HEALTH_WINDOW_MS,
} from '../lookup/providers/provider-health.service';
import type { MailService } from '../mail/mail.service';
import type { AdminStatsStore } from './admin-stats.store';
import {
  AdminSystemService,
  formatUptime,
  providerStatus,
} from './admin-system.service';

const NOW = 1_800_000_000_000;

describe('providerStatus', () => {
  it('has nothing to complain about with no calls to judge by', () => {
    expect(providerStatus(0, 0, 0)).toBe('healthy');
  });

  it.each([
    [100, 0, 200, 'healthy'],
    [100, 0.09, 200, 'healthy'],
    [100, 0.1, 200, 'degraded'],
    [100, 0.49, 200, 'degraded'],
    [100, 0.5, 200, 'down'],
    [100, 1, 0, 'down'],
    [100, 0, 3000, 'degraded'],
    [100, 0, 2999, 'healthy'],
  ] as const)(
    '%i calls, %f errors, %ims → %s',
    (calls, errorRate, latency, expected) => {
      expect(providerStatus(calls, errorRate, latency)).toBe(expected);
    },
  );
});

describe('formatUptime', () => {
  it('reads in the biggest two units', () => {
    expect(formatUptime(45)).toBe('0m');
    expect(formatUptime(3 * 60)).toBe('3m');
    expect(formatUptime(2 * 3600 + 5 * 60)).toBe('2h 5m');
    expect(formatUptime(3 * 86_400 + 4 * 3600 + 59)).toBe('3d 4h');
  });
});

const setup = (
  options: {
    security?: boolean;
    cache?: 'redis' | 'redis-down' | 'memory';
    mail?: boolean;
    gateway?: boolean;
    latencyMs?: number;
    connections?: number;
    overdue?: number;
    scheduler?: string;
  } = {},
) => {
  const health = new ProviderHealthService();
  const stats = {
    databaseStatus: jest.fn(() =>
      Promise.resolve({
        latencyMs: options.latencyMs ?? 3,
        connections: options.connections ?? 5,
        maxConnections: 100,
      }),
    ),
    monitorStatus: jest.fn(() =>
      Promise.resolve({
        running: 10,
        overdue: options.overdue ?? 0,
        failing: 2,
      }),
    ),
  };
  const service = new AdminSystemService(
    health,
    stats as unknown as AdminStatsStore,
    { mode: options.cache ?? 'memory' } as unknown as CacheService,
    { configured: options.mail ?? true } as unknown as MailService,
    { enabled: options.gateway ?? true } as unknown as GatewayClient,
    {
      get: (key: string) =>
        key === 'ABUSEIPDB_API_KEY'
          ? options.security === false
            ? undefined
            : 'key'
          : key === 'MONITORING_ENABLED'
            ? options.scheduler
            : undefined,
    } as unknown as ConfigService,
  );
  return { service, health, stats };
};

describe('AdminSystemService.providers', () => {
  it('lists the four providers with their call counts', () => {
    const { service, health } = setup();
    health.record('dns', true, 100, NOW - 1000);
    health.record('dns', true, 300, NOW - 500);

    const providers = service.providers(NOW);

    expect(providers.map((p) => p.id)).toEqual([
      'prv_dns',
      'prv_geo',
      'prv_asn',
      'prv_security',
    ]);
    expect(providers[0]).toMatchObject({
      status: 'healthy',
      latencyMs: 200,
      errorRate: 0,
      calls: 2,
    });
    expect(providers[0]).not.toHaveProperty('circuit');
  });

  it('says a provider nobody called has no data, rather than pretending it is fine', () => {
    const { service } = setup();

    const geo = service.providers(NOW).find((p) => p.id === 'prv_geo');

    expect(geo).toMatchObject({ calls: 0, status: 'healthy' });
    expect(geo?.detail).toMatch(/No lookups/);
  });

  it('reports a failing provider as down', () => {
    const { service, health } = setup();
    for (let i = 0; i < 10; i += 1) {
      health.record('geo', false, 1000, NOW - 100);
    }

    expect(
      service.providers(NOW).find((p) => p.id === 'prv_geo'),
    ).toMatchObject({ status: 'down', errorRate: 1, calls: 10 });
  });

  it('forgets calls older than the window', () => {
    const { service, health } = setup();
    health.record('asn', false, 10, NOW - HEALTH_WINDOW_MS - 1);

    expect(service.providers(NOW).find((p) => p.id === 'prv_asn')?.calls).toBe(
      0,
    );
  });

  it('reports the security provider as down, and why, when it has no API key', () => {
    const { service } = setup({ security: false });

    const security = service
      .providers(NOW)
      .find((p) => p.id === 'prv_security');

    expect(security).toMatchObject({ status: 'down', calls: 0 });
    expect(security?.detail).toContain('ABUSEIPDB_API_KEY');
  });
});

describe('AdminSystemService.services', () => {
  const byId = async (options: Parameters<typeof setup>[0]) => {
    const { service } = setup(options);
    return Object.fromEntries((await service.services()).map((s) => [s.id, s]));
  };

  it('measures the database and shows how full its connection slots are', async () => {
    const services = await byId({ latencyMs: 12, connections: 7 });

    expect(services.svc_pg).toMatchObject({
      status: 'healthy',
      metric: { label: 'Connections', value: '7 / 100' },
    });
    expect(services.svc_pg.detail).toContain('12 ms');
  });

  it('flags a slow or nearly full database', async () => {
    expect((await byId({ latencyMs: 800 })).svc_pg.status).toBe('degraded');
    expect((await byId({ connections: 85 })).svc_pg.status).toBe('degraded');
  });

  it.each([
    ['redis', 'healthy', 'Redis'],
    ['redis-down', 'degraded', 'Redis'],
    ['memory', 'healthy', 'In-memory'],
  ] as const)('cache mode %s is %s', async (cache, status, metric) => {
    const services = await byId({ cache });

    expect(services.svc_cache).toMatchObject({
      status,
      metric: { value: metric },
    });
  });

  it('flags monitors that are overdue, and says the scheduler is off where it is', async () => {
    expect((await byId({ overdue: 3 })).svc_monitoring).toMatchObject({
      status: 'degraded',
    });
    expect((await byId({ overdue: 3 })).svc_monitoring.detail).toContain(
      '3 of 10',
    );
    expect(
      (await byId({ scheduler: 'false' })).svc_monitoring.detail,
    ).toContain('scheduler is off');
    expect((await byId({})).svc_monitoring.metric).toEqual({
      label: 'Failing',
      value: '2',
    });
  });

  it('shows email and billing as degraded when they are not configured', async () => {
    const off = await byId({ mail: false, gateway: false });
    const on = await byId({ mail: true, gateway: true });

    expect(off.svc_mail.status).toBe('degraded');
    expect(off.svc_billing).toMatchObject({
      status: 'degraded',
      metric: { value: 'Off' },
    });
    expect(on.svc_mail.status).toBe('healthy');
    expect(on.svc_billing).toMatchObject({
      status: 'healthy',
      metric: { value: 'On' },
    });
  });

  it('lists the six services', async () => {
    expect(Object.keys(await byId({}))).toEqual([
      'svc_api',
      'svc_pg',
      'svc_cache',
      'svc_monitoring',
      'svc_mail',
      'svc_billing',
    ]);
  });
});
