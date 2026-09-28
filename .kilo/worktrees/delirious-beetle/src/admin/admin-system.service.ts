import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GatewayClient } from '../billing/gateway.client';
import { CacheService } from '../cache/cache.service';
import type {
  HealthStatus,
  ProviderHealth,
  ProviderKey,
  SystemService,
} from '../contracts';
import { ProviderHealthService } from '../lookup/providers/provider-health.service';
import { MailService } from '../mail/mail.service';
import { AdminStatsStore } from './admin-stats.store';

/** A monitor this far past its next check means the scheduler is behind or off everywhere. */
const MONITOR_GRACE_MINUTES = 10;
const SLOW_DATABASE_MS = 500;

const PROVIDERS: { key: ProviderKey; name: string; role: string }[] = [
  {
    key: 'dns',
    name: 'DNS resolver',
    role: 'DNS over HTTPS (Cloudflare, then Google)',
  },
  { key: 'geo', name: 'GeoIP', role: 'Geolocation (DB-IP, local database)' },
  {
    key: 'asn',
    name: 'ASN / network',
    role: 'Network ownership (local database)',
  },
  {
    key: 'security',
    name: 'AbuseIPDB',
    role: 'Reputation, VPN, proxy and Tor',
  },
];

/** 10% of recent calls failing is worth a look; half is an outage. With no calls there is nothing to judge by. */
export const providerStatus = (
  calls: number,
  errorRate: number,
  latencyMs: number,
): HealthStatus => {
  if (calls === 0) {
    return 'healthy';
  }
  if (errorRate >= 0.5) {
    return 'down';
  }
  return errorRate >= 0.1 || latencyMs >= 3000 ? 'degraded' : 'healthy';
};

export const formatUptime = (seconds: number): string => {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
};

/** What the admin view shows for providers and infrastructure: measured, not asserted. */
@Injectable()
export class AdminSystemService {
  constructor(
    private readonly health: ProviderHealthService,
    private readonly stats: AdminStatsStore,
    private readonly cache: CacheService,
    private readonly mail: MailService,
    private readonly gateway: GatewayClient,
    private readonly config: ConfigService,
  ) {}

  providers(now = Date.now()): ProviderHealth[] {
    const securityConfigured = Boolean(
      this.config.get<string>('ABUSEIPDB_API_KEY')?.trim(),
    );

    return PROVIDERS.map(({ key, name, role }) => {
      const stats = this.health.statsFor(key, now);
      if (key === 'security' && !securityConfigured) {
        return {
          id: `prv_${key}`,
          provider: name,
          role,
          status: 'down' as const,
          latencyMs: 0,
          errorRate: 0,
          calls: 0,
          detail:
            'ABUSEIPDB_API_KEY is not set, so every lookup reports the security section as unavailable.',
        };
      }
      return {
        id: `prv_${key}`,
        provider: name,
        role,
        status: providerStatus(stats.calls, stats.errorRate, stats.latencyMs),
        latencyMs: stats.latencyMs,
        errorRate: stats.errorRate,
        calls: stats.calls,
        ...(stats.calls === 0
          ? {
              detail:
                'No lookups reached this provider in the last 15 minutes.',
            }
          : {}),
      };
    });
  }

  async services(now = new Date()): Promise<SystemService[]> {
    const [database, monitors] = await Promise.all([
      this.stats.databaseStatus(),
      this.stats.monitorStatus(now, MONITOR_GRACE_MINUTES),
    ]);

    const connectionsFull =
      database.connections / database.maxConnections > 0.8;
    const cacheMode = this.cache.mode;
    const schedulerOn =
      this.config.get<string>('MONITORING_ENABLED') !== 'false';
    const billing = this.gateway.enabled;

    return [
      {
        id: 'svc_api',
        name: 'API',
        status: 'healthy',
        detail: `This instance: Node ${process.version}, up ${formatUptime(process.uptime())}`,
        metric: {
          label: 'Memory',
          value: `${Math.round(process.memoryUsage.rss() / 1024 / 1024)} MB`,
        },
      },
      {
        id: 'svc_pg',
        name: 'PostgreSQL',
        status:
          database.latencyMs >= SLOW_DATABASE_MS || connectionsFull
            ? 'degraded'
            : 'healthy',
        detail: `Answered in ${database.latencyMs} ms`,
        metric: {
          label: 'Connections',
          value: `${database.connections} / ${database.maxConnections}`,
        },
      },
      {
        id: 'svc_cache',
        name: 'Cache',
        status: cacheMode === 'redis-down' ? 'degraded' : 'healthy',
        detail:
          cacheMode === 'redis'
            ? 'Redis connected; caches and rate limits are shared across instances'
            : cacheMode === 'redis-down'
              ? 'Redis is unreachable; this instance is on its in-process fallback'
              : 'No Redis configured; caches and rate limits are per instance',
        metric: {
          label: 'Mode',
          value: cacheMode === 'memory' ? 'In-memory' : 'Redis',
        },
      },
      {
        id: 'svc_monitoring',
        name: 'Monitoring',
        status: monitors.overdue > 0 ? 'degraded' : 'healthy',
        detail:
          monitors.overdue > 0
            ? `${monitors.overdue} of ${monitors.running} monitors are more than ${MONITOR_GRACE_MINUTES} minutes overdue`
            : `${monitors.running} monitors running${schedulerOn ? '' : ' (the scheduler is off on this instance)'}`,
        metric: { label: 'Failing', value: String(monitors.failing) },
      },
      {
        id: 'svc_mail',
        name: 'Email',
        status: this.mail.configured ? 'healthy' : 'degraded',
        detail: this.mail.configured
          ? 'SMTP configured'
          : 'SMTP_HOST is not set: emails are logged, not sent',
        metric: {
          label: 'Transport',
          value: this.mail.configured ? 'SMTP' : 'Log only',
        },
      },
      {
        id: 'svc_billing',
        name: 'Billing',
        status: billing ? 'healthy' : 'degraded',
        detail: billing
          ? 'Payment gateway configured; payments are checked in the background'
          : 'The payment gateway is not configured: plans can not be bought',
        metric: { label: 'Gateway', value: billing ? 'On' : 'Off' },
      },
    ];
  }
}
