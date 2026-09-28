import type { ConfigService } from '@nestjs/config';
import type { AbuseService } from '../abuse/abuse.service';
import { CacheService } from '../cache/cache.service';
import { ApiException } from '../common/dto/api-exception';
import { PLAN_API_LIMITS, PLAN_LOOKUP_LIMITS } from '../common/plans';
import type {
  DomainCheckResult,
  GeoLocation,
  NetworkInfo,
  Plan,
  User,
} from '../contracts';
import type { UsageScope } from '../usage/usage.service';
import type { UsageService } from '../usage/usage.service';
import type { UsageEventsService } from '../usage/usage-events.service';
import type { CheckStore } from './check-store.service';
import { LookupService, type Viewer } from './lookup.service';
import type { AsnProvider } from './providers/asn.provider';
import type { DnsLookup, DnsProvider } from './providers/dns.provider';
import type { GeoProvider } from './providers/geo.provider';
import { ProviderHealthService } from './providers/provider-health.service';
import { ProviderRunner } from './providers/provider-runner';
import {
  ProviderTimeoutError,
  ProviderUnavailableError,
} from './providers/provider.types';
import {
  buildSecurityIntelligence,
  type SecurityProvider,
} from './providers/security.provider';

const SECRET_MX = 'mx-secret.example';

const location: GeoLocation = {
  country: 'United States',
  countryCode: 'US',
  region: 'California',
  city: 'Mountain View',
  timezone: 'America/Los_Angeles',
  latitude: 37.4,
  longitude: -122.08,
  accuracyRadiusKm: 50,
};
const network: NetworkInfo = {
  asn: 15169,
  asnName: 'Google LLC',
  organization: 'Google LLC',
  isp: 'Google LLC',
  network: '8.8.8.0/24',
  connectionType: 'datacenter',
  anycast: false,
};
const resolved = (...ips: string[]): DnsLookup => ({
  status: 'resolved',
  resolver: '1.1.1.1',
  records: ips.map((ip, index) => ({
    id: `a_${index}`,
    type: 'A' as const,
    name: 'example.com',
    value: ip,
    ttl: 60,
  })),
  addresses: ips.map((ip) => ({
    ip,
    version: 4 as const,
    source: 'A' as const,
  })),
});

const user = (plan: Plan, id = `u_${plan}`): User => ({
  id,
  name: 'Test',
  email: `${id}@example.com`,
  role: 'user',
  plan,
  effectivePlan: plan,
  emailVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
});
const viewerOf = (account: User | null, ip = '203.0.113.9'): Viewer => ({
  user: account,
  ip,
});

/** The same atomic "count up to the limit" contract as the real UsageService, held in memory. */
class FakeUsage {
  counters = new Map<string, number>();
  visitorId(ip: string | undefined) {
    return `visitor:${ip}`;
  }
  scopeFor(account: User | null, ip: string | undefined): UsageScope {
    return {
      kind: account ? 'account' : 'anonymous',
      key: account ? `user:${account.id}` : `anon:${ip}`,
      limit: account ? PLAN_LOOKUP_LIMITS[account.plan] : 2,
      resetsAt: new Date('2026-10-01T00:00:00.000Z'),
    };
  }
  apiScopeFor(account: User): UsageScope {
    return {
      kind: 'api',
      key: `api:${account.id}`,
      limit: PLAN_API_LIMITS[account.plan],
      resetsAt: new Date('2026-10-01T00:00:00.000Z'),
    };
  }
  getUsed(scope: UsageScope) {
    return Promise.resolve(this.counters.get(scope.key) ?? 0);
  }
  tryConsume(scope: UsageScope) {
    const used = this.counters.get(scope.key) ?? 0;
    if (used >= scope.limit) {
      return Promise.resolve({ allowed: false, used });
    }
    this.counters.set(scope.key, used + 1);
    return Promise.resolve({ allowed: true, used: used + 1 });
  }
  refund(scope: UsageScope) {
    this.counters.set(
      scope.key,
      Math.max((this.counters.get(scope.key) ?? 0) - 1, 0),
    );
    return Promise.resolve();
  }
}

const setup = (options: { forceFail?: string; blocked?: boolean } = {}) => {
  const cache = new CacheService({
    get: () => undefined,
  } as unknown as ConfigService);
  const runner = new ProviderRunner(
    cache,
    {
      get: (key: string) =>
        key === 'LOOKUP_FORCE_FAIL' ? options.forceFail : undefined,
    } as unknown as ConfigService,
    new ProviderHealthService(),
  );
  const abuse = {
    isBlocked: jest.fn(() => Promise.resolve(options.blocked ?? false)),
    note: jest.fn(() => Promise.resolve()),
  };

  const dns = {
    resolveAddresses: jest.fn(() => Promise.resolve(resolved('8.8.8.8'))),
    resolveAdvanced: jest.fn(() =>
      Promise.resolve([
        {
          id: 'mx_0',
          type: 'MX' as const,
          name: 'example.com',
          value: SECRET_MX,
          ttl: 60,
          priority: 10,
        },
      ]),
    ),
    reverse: jest.fn(() => Promise.resolve(['one.one.one.one'])),
  };
  const geo = { locate: jest.fn((): GeoLocation => location) };
  const asn = { lookup: jest.fn((): NetworkInfo => network) };
  const security = {
    assess: jest.fn(() =>
      Promise.resolve(
        buildSecurityIntelligence(
          { abuseConfidenceScore: 0, reports: [] },
          network,
          false,
        ),
      ),
    ),
  };
  const usage = new FakeUsage();
  const events = { record: jest.fn(() => Promise.resolve()) };
  const store = {
    save: jest.fn((): Promise<void> => Promise.resolve()),
    // Like a user who already has the report: their existing row's id is the cached report's own.
    saveFromCache: jest.fn(
      (...args: [string, DomainCheckResult]): Promise<string> =>
        Promise.resolve(args[1].id),
    ),
    find: jest.fn((): Promise<DomainCheckResult | null> =>
      Promise.resolve(null),
    ),
  };

  const service = new LookupService(
    runner,
    dns as unknown as DnsProvider,
    geo as unknown as GeoProvider,
    asn as unknown as AsnProvider,
    security as unknown as SecurityProvider,
    cache,
    usage as unknown as UsageService,
    store as unknown as CheckStore,
    events as unknown as UsageEventsService,
    abuse as unknown as AbuseService,
  );
  return { service, dns, geo, asn, security, usage, store, events, abuse };
};

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as ApiException;
  }
  throw new Error('expected the lookup to fail');
};

describe('LookupService — a domain lookup', () => {
  it('assembles DNS, geolocation, network and security into one result', async () => {
    const { service } = setup();
    const { result, quota, savedToHistory } = await service.check(
      'https://Example.com/path?x=1',
      viewerOf(user('pro')),
      false,
    );

    expect(result).toMatchObject({
      input: 'https://Example.com/path?x=1',
      target: 'example.com',
      type: 'domain',
      status: 'completed',
      cache: { hit: false },
      hosting: { provider: 'Google', kind: 'cloud' }, // corporate suffix dropped
      reverseDns: null,
    });
    expect(result.id).toMatch(/^chk_/);
    expect(result.dns).toMatchObject({
      status: 'resolved',
      resolver: '1.1.1.1',
    });
    expect(result.ips).toHaveLength(1);
    expect(result.ips[0]).toMatchObject({
      ip: '8.8.8.8',
      version: 4,
      source: 'A',
      geo: { status: 'ok' },
      network: { status: 'ok' },
      security: { status: 'ok' },
    });
    expect(result.providers.security.status).toBe('ok');
    expect(quota).toMatchObject({
      scope: 'account',
      used: 1,
      limit: 500,
      period: 'month',
    });
    expect(savedToHistory).toBe(true);
  });

  it('still returns DNS, location and network when the security provider fails (partial results)', async () => {
    const { service, security } = setup();
    security.assess.mockRejectedValue(
      new ProviderUnavailableError(
        'The security data source is not responding.',
      ),
    );

    const { result } = await service.check(
      'example.com',
      viewerOf(user('free')),
      false,
    );

    expect(result.status).toBe('partial');
    expect(result.ips[0].geo.status).toBe('ok');
    expect(result.ips[0].network.status).toBe('ok');
    expect(result.ips[0].security).toEqual({
      status: 'unavailable',
      message: 'The security data source is not responding.',
    });
    expect(result.providers.security).toMatchObject({ status: 'unavailable' });
    expect(result.providers.dns.status).toBe('ok');
  });

  it('reports a slow provider as "timeout", not "unavailable"', async () => {
    const { service, security } = setup();
    security.assess.mockRejectedValue(new ProviderTimeoutError());

    const { result } = await service.check(
      'example.com',
      viewerOf(user('free')),
      false,
    );
    expect(result.ips[0].security.status).toBe('timeout');
    expect(result.providers.security.status).toBe('timeout');
  });

  it('can be told to fail one provider on demand (LOOKUP_FORCE_FAIL) without touching it', async () => {
    const { service, security } = setup({ forceFail: 'security' });

    const { result } = await service.check(
      'example.com',
      viewerOf(user('free')),
      false,
    );

    expect(security.assess).not.toHaveBeenCalled();
    expect(result.status).toBe('partial');
    expect(result.ips[0].security).toMatchObject({
      status: 'unavailable',
      message: expect.stringMatching(/forced to fail/) as unknown,
    });
    expect(result.ips[0].geo.status).toBe('ok');
  });

  it('skips addresses that are not publicly routable (a name pointing at 10.x is not a lookup target)', async () => {
    const { service, dns, geo } = setup();
    dns.resolveAddresses.mockResolvedValue(
      resolved('10.0.0.5', '8.8.8.8', '169.254.169.254'),
    );

    const { result } = await service.check(
      'example.com',
      viewerOf(user('pro')),
      false,
    );

    expect(result.ips.map((ip) => ip.ip)).toEqual(['8.8.8.8']);
    expect(geo.locate).toHaveBeenCalledTimes(1);
  });

  it('analyzes at most six addresses per lookup', async () => {
    const { service, dns } = setup();
    dns.resolveAddresses.mockResolvedValue(
      resolved(
        ...Array.from({ length: 12 }, (_, index) => `8.8.8.${index + 1}`),
      ),
    );

    const { result } = await service.check(
      'example.com',
      viewerOf(user('pro')),
      false,
    );
    expect(result.ips).toHaveLength(6);
  });

  it('widens the map accuracy for anycast networks, whose location is not a single place', async () => {
    const { service, asn } = setup();
    asn.lookup.mockReturnValue({
      ...network,
      connectionType: 'cdn',
      anycast: true,
    });

    const { result } = await service.check(
      'example.com',
      viewerOf(user('pro')),
      false,
    );
    const geo = result.ips[0].geo;
    expect(geo.status === 'ok' && geo.data.accuracyRadiusKm).toBe(2000);
  });

  it('treats a name that does not exist as a valid answer, not an error', async () => {
    const { service, dns, usage } = setup();
    dns.resolveAddresses.mockResolvedValue({
      status: 'nxdomain',
      resolver: '1.1.1.1',
      records: [],
      addresses: [],
    });

    const { result, quota } = await service.check(
      'gone.example.com',
      viewerOf(user('free')),
      false,
    );

    expect(result.status).toBe('no_records');
    expect(result.dns?.status).toBe('nxdomain');
    expect(result.ips).toEqual([]);
    expect(quota.used).toBe(1); // the resolvers did real work
    expect(usage.counters.size).toBe(1);
  });

  it('marks the check partial when only the premium DNS records could not be fetched', async () => {
    const { service, dns } = setup();
    dns.resolveAdvanced.mockRejectedValue(new ProviderUnavailableError('down'));

    const { result } = await service.check(
      'example.com',
      viewerOf(user('pro')),
      false,
    );
    expect(result.status).toBe('partial');
    expect(result.providers.dns.status).toBe('unavailable');
    expect(result.dns?.records.length).toBeGreaterThan(0);
  });
});

describe('LookupService — an IP lookup', () => {
  it('has no DNS section, but reverse DNS for the entitled', async () => {
    const { service, dns } = setup();
    const { result } = await service.check(
      '8.8.8.8',
      viewerOf(user('pro')),
      false,
    );

    expect(result.dns).toBeNull();
    expect(result.type).toBe('ipv4');
    expect(result.reverseDns).toEqual({
      access: 'included',
      data: ['one.one.one.one'],
    });
    expect(dns.reverse).toHaveBeenCalledWith('8.8.8.8', expect.anything());
    expect(result.ips[0]).not.toHaveProperty('source');
  });

  it('locks reverse DNS for a free viewer', async () => {
    const { service } = setup();
    const { result } = await service.check(
      '8.8.8.8',
      viewerOf(user('free')),
      false,
    );
    expect(result.reverseDns).toEqual({
      access: 'locked',
      requiredPlan: 'pro',
    });
  });
});

describe('LookupService — errors and quota', () => {
  it('rejects bad input with the reason, before touching quota or any provider', async () => {
    const { service, dns, usage } = setup();

    const error = await errorOf(
      service.check('ftp://example.com', viewerOf(null), false),
    );

    expect(error).toMatchObject({
      code: 'INVALID_INPUT',
      details: { reason: 'unsupported_scheme' },
    });
    expect(dns.resolveAddresses).not.toHaveBeenCalled();
    expect(usage.counters.size).toBe(0);
  });

  it('refuses private addresses (the SSRF guard) without spending anything', async () => {
    const { service, usage } = setup();
    const error = await errorOf(
      service.check('169.254.169.254', viewerOf(null), false),
    );
    expect(error).toMatchObject({
      code: 'INVALID_INPUT',
      details: { reason: 'private_ip' },
    });
    expect(usage.counters.size).toBe(0);
  });

  it('gives a signed-out visitor two lookups a day, then QUOTA_EXCEEDED', async () => {
    const { service, dns } = setup();
    const visitor = viewerOf(null);

    await service.check('one.example.com', visitor, false);
    await service.check('two.example.com', visitor, false);
    dns.resolveAddresses.mockClear();
    const error = await errorOf(
      service.check('three.example.com', visitor, false),
    );

    expect(error.code).toBe('QUOTA_EXCEEDED');
    expect(error.details).toEqual({
      scope: 'anonymous',
      limit: 2,
      resetsAt: '2026-10-01T00:00:00.000Z',
    });
    expect(dns.resolveAddresses).not.toHaveBeenCalled();
  });

  it('counts each visitor separately', async () => {
    const { service } = setup();
    await service.check('a.example.com', viewerOf(null, '198.51.100.1'), false);
    await service.check('b.example.com', viewerOf(null, '198.51.100.1'), false);
    await expect(
      service.check('c.example.com', viewerOf(null, '198.51.100.2'), false),
    ).resolves.toBeDefined();
  });

  it('turns a DNS timeout into DNS_TIMEOUT and gives the lookup back', async () => {
    const { service, dns, usage } = setup();
    dns.resolveAddresses.mockRejectedValue(new ProviderTimeoutError());

    const error = await errorOf(
      service.check('slow.example.com', viewerOf(user('free')), false),
    );

    expect(error.code).toBe('DNS_TIMEOUT');
    expect(usage.counters.get('user:u_free')).toBe(0);
  });

  it('turns unreachable DNS resolvers into PROVIDER_UNAVAILABLE and gives the lookup back', async () => {
    const { service, dns, usage } = setup();
    dns.resolveAddresses.mockRejectedValue(
      new ProviderUnavailableError('DNS resolvers are not responding.'),
    );

    const error = await errorOf(
      service.check('example.com', viewerOf(user('free')), false),
    );

    expect(error).toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      message: 'DNS resolvers are not responding.',
    });
    expect(usage.counters.get('user:u_free')).toBe(0);
  });

  it('fails with PROVIDER_UNAVAILABLE, and refunds, when every source failed for every address', async () => {
    const { service, geo, asn, security, usage } = setup();
    geo.locate.mockImplementation(() => {
      throw new ProviderUnavailableError();
    });
    asn.lookup.mockImplementation(() => {
      throw new ProviderUnavailableError();
    });
    security.assess.mockRejectedValue(new ProviderUnavailableError());

    const error = await errorOf(
      service.check('8.8.8.8', viewerOf(user('free')), false),
    );

    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(usage.counters.get('user:u_free')).toBe(0);
  });
});

describe('LookupService — caching', () => {
  it('serves a repeat from cache without spending quota or calling providers again', async () => {
    const { service, dns, usage } = setup();
    const account = user('free');

    const first = await service.check('example.com', viewerOf(account), false);
    dns.resolveAddresses.mockClear();
    const second = await service.check(
      'https://EXAMPLE.com/other',
      viewerOf(account),
      false,
    );

    expect(first.result.cache.hit).toBe(false);
    expect(second.result.cache).toMatchObject({ hit: true });
    expect(second.result.id).toBe(first.result.id);
    expect(second.result.input).toBe('https://EXAMPLE.com/other'); // echoes this request, not the cached one
    expect(second.quota.used).toBe(1);
    expect(dns.resolveAddresses).not.toHaveBeenCalled();
    expect(usage.counters.get('user:u_free')).toBe(1);
  });

  it('bypasses the cache on refresh, and that counts against quota', async () => {
    const { service, dns, usage } = setup();
    const account = user('free');

    await service.check('example.com', viewerOf(account), false);
    dns.resolveAddresses.mockClear();
    const refreshed = await service.check(
      'example.com',
      viewerOf(account),
      true,
    );

    expect(dns.resolveAddresses).toHaveBeenCalledTimes(1);
    expect(refreshed.result.cache.hit).toBe(false);
    expect(usage.counters.get('user:u_free')).toBe(2);
  });

  it('still serves cached results once quota is used up', async () => {
    const { service } = setup();
    const visitor = viewerOf(null);
    await service.check('one.example.com', visitor, false);
    await service.check('two.example.com', visitor, false);

    await expect(
      service.check('one.example.com', visitor, false),
    ).resolves.toMatchObject({
      result: { cache: { hit: true } },
    });
  });

  it("never lets one viewer's premium data leak to another through the cache", async () => {
    const { service } = setup();

    const asPro = await service.check(
      'example.com',
      viewerOf(user('pro')),
      false,
    );
    const asFree = await service.check(
      'example.com',
      viewerOf(user('free')),
      false,
    ); // cache hit

    expect(JSON.stringify(asPro.result)).toContain(SECRET_MX);
    expect(asFree.result.cache.hit).toBe(true);
    expect(asFree.result.dns?.advanced).toEqual({
      access: 'locked',
      requiredPlan: 'pro',
    });
    expect(JSON.stringify(asFree.result)).not.toContain(SECRET_MX);
  });

  it('runs identical concurrent requests once, so a double click spends one lookup', async () => {
    const { service, dns, usage } = setup();
    dns.resolveAddresses.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(resolved('8.8.8.8')), 20),
        ),
    );
    const account = viewerOf(user('free'));

    const [a, b] = await Promise.all([
      service.check('example.com', account, false),
      service.check('example.com', account, false),
    ]);

    expect(dns.resolveAddresses).toHaveBeenCalledTimes(1);
    expect(a.result.id).toBe(b.result.id);
    expect(usage.counters.get('user:u_free')).toBe(1);
  });
});

describe('LookupService — history and reopening', () => {
  it('saves a fresh lookup for a signed-in user, and never for a visitor', async () => {
    const { service, store } = setup();

    const anonymous = await service.check(
      'a.example.com',
      viewerOf(null),
      false,
    );
    expect(anonymous.savedToHistory).toBe(false);
    expect(store.save).not.toHaveBeenCalled();

    const signedIn = await service.check(
      'b.example.com',
      viewerOf(user('free')),
      false,
    );
    expect(signedIn.savedToHistory).toBe(true);
    expect(store.save).toHaveBeenCalledWith(
      'u_free',
      expect.objectContaining({ target: 'b.example.com' }),
    );
  });

  it('files a cache hit under the viewer too, because the cache is shared and the report may be first run by someone else', async () => {
    const { service, store, usage } = setup();
    const original = await service.check(
      'example.com',
      viewerOf(user('pro')),
      false,
    );
    store.save.mockClear();
    store.saveFromCache.mockResolvedValueOnce('chk_own_copy');

    const hit = await service.check(
      'https://EXAMPLE.com/other',
      viewerOf(user('free')),
      false,
    );

    expect(hit.result.cache.hit).toBe(true);
    expect(hit.savedToHistory).toBe(true);
    expect(hit.result.id).toBe('chk_own_copy'); // reopenable by its owner, unlike the original's id
    expect(hit.result.id).not.toBe(original.result.id);
    expect(store.save).not.toHaveBeenCalled();
    expect(store.saveFromCache).toHaveBeenCalledWith(
      'u_free',
      expect.objectContaining({
        target: 'example.com',
        input: 'https://EXAMPLE.com/other',
      }),
    );
    expect(usage.counters.get('user:u_free')).toBeUndefined(); // no quota spent
  });

  it('does not file a cache hit for a visitor', async () => {
    const { service, store } = setup();
    const original = await service.check(
      'example.com',
      viewerOf(user('free')),
      false,
    );

    const hit = await service.check('example.com', viewerOf(null), false);

    expect(hit.result.cache.hit).toBe(true);
    expect(hit.savedToHistory).toBe(false);
    expect(hit.result.id).toBe(original.result.id);
    expect(store.saveFromCache).not.toHaveBeenCalled();
  });

  it('still returns a cached result when filing it fails', async () => {
    const { service, store } = setup();
    const original = await service.check(
      'example.com',
      viewerOf(user('pro')),
      false,
    );
    store.saveFromCache.mockRejectedValue(new Error('db down'));

    const hit = await service.check(
      'example.com',
      viewerOf(user('free')),
      false,
    );

    expect(hit.result.cache.hit).toBe(true);
    expect(hit.savedToHistory).toBe(false);
    expect(hit.result.id).toBe(original.result.id);
  });

  it('still returns the result when saving to history fails', async () => {
    const { service, store } = setup();
    store.save.mockRejectedValue(new Error('db down'));

    const response = await service.check(
      'example.com',
      viewerOf(user('free')),
      false,
    );
    expect(response.savedToHistory).toBe(false);
    expect(response.result.status).toBe('completed');
  });

  it("reopens a saved check with the owner's current entitlements and no quota spent", async () => {
    const { service, store, usage } = setup();
    const captured = (
      await service.check('example.com', viewerOf(user('pro')), false)
    ).result;
    store.find.mockResolvedValue(captured);
    usage.counters.clear();

    const asFree = await service.getSaved(captured.id, user('free'));
    const asPro = await service.getSaved(captured.id, user('pro'));

    expect(asFree.result.dns?.advanced.access).toBe('locked');
    expect(JSON.stringify(asFree.result)).not.toContain(SECRET_MX);
    expect(asPro.result.dns?.advanced.access).toBe('included');
    expect(asFree).toMatchObject({ savedToHistory: true, quota: { used: 0 } });
  });

  it('answers NOT_FOUND for a check that is missing or belongs to someone else', async () => {
    const { service } = setup();
    const error = await errorOf(service.getSaved('chk_nope', user('free')));
    expect(error.code).toBe('NOT_FOUND');
  });
});

describe('LookupService — usage events for analytics', () => {
  it('records a fresh lookup with the providers that answered and their timings', async () => {
    const { service, events } = setup();
    await service.check('example.com', viewerOf(user('pro')), false);

    expect(events.record).toHaveBeenCalledTimes(1);
    expect(events.record).toHaveBeenCalledWith('u_pro', {
      status: 'completed',
      cacheHit: false,
      durationMs: expect.any(Number) as unknown,
      latency: expect.objectContaining({
        dns: expect.any(Number) as unknown,
      }) as unknown,
    });
  });

  it('leaves a provider out of the latency map when it failed', async () => {
    const { service, events, security } = setup();
    security.assess.mockRejectedValue(new ProviderUnavailableError('down'));
    await service.check('example.com', viewerOf(user('pro')), false);

    const [, event] = events.record.mock.calls[0] as unknown as [
      string,
      { status: string; latency: Record<string, number> },
    ];
    expect(event.status).toBe('partial');
    expect(Object.keys(event.latency).sort()).toEqual(['asn', 'dns', 'geo']);
  });

  it('records a cache hit as a hit, with no latency measured', async () => {
    const { service, events } = setup();
    await service.check('example.com', viewerOf(user('pro')), false);
    events.record.mockClear();

    await service.check('example.com', viewerOf(user('pro')), false);

    expect(events.record).toHaveBeenCalledWith('u_pro', {
      status: 'completed',
      cacheHit: true,
      durationMs: expect.any(Number) as unknown,
    });
  });

  it('records a lookup that produced nothing as failed', async () => {
    const { service, events, dns } = setup();
    dns.resolveAddresses.mockRejectedValue(new ProviderTimeoutError());

    await errorOf(
      service.check('slow.example.com', viewerOf(user('pro')), false),
    );

    expect(events.record).toHaveBeenCalledWith('u_pro', {
      status: 'failed',
      cacheHit: false,
      durationMs: expect.any(Number) as unknown,
    });
  });

  it('does not record anything for a signed-out visitor, a rejected input or a quota refusal', async () => {
    const { service, events } = setup();
    const visitor = viewerOf(null);
    await service.check('a.example.com', visitor, false);
    await service.check('b.example.com', visitor, false);
    await errorOf(service.check('c.example.com', visitor, false)); // quota
    await errorOf(service.check('ftp://x.com', viewerOf(user('pro')), false)); // invalid

    expect(events.record).not.toHaveBeenCalled();
  });

  it('does not let a failing event write affect the lookup', async () => {
    const { service, events } = setup();
    events.record.mockRejectedValue(new Error('db down'));

    await expect(
      service.check('example.com', viewerOf(user('pro')), false),
    ).resolves.toMatchObject({
      result: { status: 'completed' },
    });
  });
});

describe('LookupService — inspect (what monitors use)', () => {
  it('returns the full, ungated result and spends nothing: no quota, no history, no analytics event', async () => {
    const { service, usage, store, events } = setup();

    const result = await service.inspect('example.com', 'domain');

    expect(result.status).toBe('completed');
    expect(result.dns?.advanced.access).toBe('included');
    expect(JSON.stringify(result)).toContain(SECRET_MX);
    expect(usage.counters.size).toBe(0);
    expect(store.save).not.toHaveBeenCalled();
    expect(events.record).not.toHaveBeenCalled();
  });

  it('reads DNS live every time, so a change is seen when it happens', async () => {
    const { service, dns } = setup();

    await service.inspect('example.com', 'domain');
    await service.inspect('example.com', 'domain');

    expect(dns.resolveAddresses).toHaveBeenCalledTimes(2);
    expect(dns.resolveAdvanced).toHaveBeenCalledTimes(2);
  });

  it('reads DNS live even when a person’s lookup has just cached it', async () => {
    const { service, dns } = setup();
    await service.check('example.com', viewerOf(user('pro')), false);
    dns.resolveAddresses.mockClear();

    await service.inspect('example.com', 'domain');

    expect(dns.resolveAddresses).toHaveBeenCalledTimes(1);
  });

  it('reuses a cached security reading, which keeps the reputation API budget for people’s own lookups', async () => {
    const { service, security } = setup();
    await service.check('example.com', viewerOf(user('pro')), false);
    security.assess.mockClear();

    await service.inspect('example.com', 'domain');

    expect(security.assess).not.toHaveBeenCalled();
  });

  it('throws the same errors as a lookup when nothing can be read', async () => {
    const { service, dns } = setup();
    dns.resolveAddresses.mockRejectedValue(new ProviderTimeoutError());

    const error = await errorOf(service.inspect('example.com', 'domain'));

    expect(error.code).toBe('DNS_TIMEOUT');
  });

  it('analyses an IP address too', async () => {
    const { service } = setup();

    const result = await service.inspect('1.1.1.1', 'ipv4');

    expect(result.type).toBe('ipv4');
    expect(result.reverseDns?.access).toBe('included');
  });
});

describe('LookupService — requests made with an API key', () => {
  const key = { id: 'key_1', environment: 'production' as const };
  const apiViewer = (account: User): Viewer => ({
    user: account,
    ip: '198.51.100.7',
    apiKey: key,
  });

  it('answers with the same result shape, without saving anything to history', async () => {
    const { service, store } = setup();

    const response = await service.check(
      'example.com',
      apiViewer(user('pro')),
      false,
    );

    expect(response.result.status).toBe('completed');
    expect(response.result.ips).toHaveLength(1);
    expect(response.savedToHistory).toBe(false);
    expect(store.save).not.toHaveBeenCalled();
    expect(store.saveFromCache).not.toHaveBeenCalled();
  });

  it('counts against the API allowance, and reports it as the quota', async () => {
    const { service, usage } = setup();
    const account = user('pro');

    const response = await service.check(
      'example.com',
      apiViewer(account),
      false,
    );

    expect(usage.counters.get('api:u_pro')).toBe(1);
    expect(usage.counters.get('user:u_pro')).toBeUndefined(); // web lookups untouched
    expect(response.quota).toEqual({
      scope: 'account',
      used: 1,
      limit: PLAN_API_LIMITS.pro,
      period: 'month',
      resetsAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('counts a cache hit too, because the allowance meters calls, not provider work', async () => {
    const { service, usage, dns } = setup();
    const account = user('pro');

    await service.check('example.com', apiViewer(account), false);
    dns.resolveAddresses.mockClear();
    const again = await service.check('example.com', apiViewer(account), false);

    expect(again.result.cache.hit).toBe(true);
    expect(dns.resolveAddresses).not.toHaveBeenCalled();
    expect(usage.counters.get('api:u_pro')).toBe(2);
    expect(again.quota.used).toBe(2);
  });

  it('serves results a web lookup cached, and the other way round', async () => {
    const { service, dns } = setup();
    const account = user('pro');

    await service.check('example.com', viewerOf(account), false);
    dns.resolveAddresses.mockClear();
    const viaKey = await service.check(
      'example.com',
      apiViewer(account),
      false,
    );
    expect(viaKey.result.cache.hit).toBe(true);
    expect(dns.resolveAddresses).not.toHaveBeenCalled();

    await service.check('other.example.com', apiViewer(account), false);
    dns.resolveAddresses.mockClear();
    const viaWeb = await service.check(
      'other.example.com',
      viewerOf(account),
      false,
    );
    expect(viaWeb.result.cache.hit).toBe(true);
  });

  it('echoes the target as this caller typed it', async () => {
    const { service } = setup();

    const response = await service.check(
      'https://EXAMPLE.com/some/path',
      apiViewer(user('pro')),
      false,
    );

    expect(response.result.input).toBe('https://EXAMPLE.com/some/path');
    expect(response.result.target).toBe('example.com');
  });

  it('refuses with QUOTA_EXCEEDED at the limit, and counts nothing more', async () => {
    const { service, usage } = setup();
    const account = user('pro');
    usage.counters.set('api:u_pro', PLAN_API_LIMITS.pro);

    const error = await errorOf(
      service.check('example.com', apiViewer(account), false),
    );

    expect(error.code).toBe('QUOTA_EXCEEDED');
    expect(error.message).toContain('API requests');
    expect(error.details).toMatchObject({
      scope: 'api',
      limit: PLAN_API_LIMITS.pro,
      resetsAt: '2026-10-01T00:00:00.000Z',
    });
    expect(usage.counters.get('api:u_pro')).toBe(PLAN_API_LIMITS.pro);
  });

  it('is not blocked by an exhausted web quota, nor does it use one', async () => {
    const { service, usage } = setup();
    const account = user('pro');
    usage.counters.set('user:u_pro', PLAN_LOOKUP_LIMITS.pro);

    await expect(
      service.check('example.com', apiViewer(account), false),
    ).resolves.toMatchObject({ result: { status: 'completed' } });
  });

  it('refunds a request that got nothing back', async () => {
    const { service, usage, dns } = setup();
    dns.resolveAddresses.mockRejectedValue(new ProviderTimeoutError());

    const error = await errorOf(
      service.check('slow.example.com', apiViewer(user('pro')), false),
    );

    expect(error.code).toBe('DNS_TIMEOUT');
    expect(usage.counters.get('api:u_pro')).toBe(0);
  });

  it('refunds each caller when concurrent identical requests fail together', async () => {
    const { service, usage, dns } = setup();
    dns.resolveAddresses.mockRejectedValue(new ProviderTimeoutError());
    const account = user('pro');

    await Promise.all([
      errorOf(service.check('slow.example.com', apiViewer(account), false)),
      errorOf(service.check('slow.example.com', apiViewer(account), false)),
    ]);

    expect(usage.counters.get('api:u_pro')).toBe(0);
  });

  it('runs identical concurrent requests through the providers once, but charges every caller', async () => {
    const { service, usage, dns } = setup();
    dns.resolveAddresses.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(resolved('8.8.8.8')), 20),
        ),
    );
    const account = user('pro');

    const [a, b, c] = await Promise.all([
      service.check('example.com', apiViewer(account), false),
      service.check('example.com', apiViewer(account), false),
      service.check('example.com', apiViewer(account), false),
    ]);

    expect(dns.resolveAddresses).toHaveBeenCalledTimes(1);
    expect(usage.counters.get('api:u_pro')).toBe(3);
    expect([a.quota.used, b.quota.used, c.quota.used].sort()).toEqual([
      1, 2, 3,
    ]);
  });

  it('bypasses the cache on refresh and still counts one request', async () => {
    const { service, usage, dns } = setup();
    const account = user('pro');
    await service.check('example.com', apiViewer(account), false);
    dns.resolveAddresses.mockClear();

    const fresh = await service.check('example.com', apiViewer(account), true);

    expect(fresh.result.cache.hit).toBe(false);
    expect(dns.resolveAddresses).toHaveBeenCalledTimes(1);
    expect(usage.counters.get('api:u_pro')).toBe(2);
  });

  it('logs every request as an api event: fresh, cached and failed', async () => {
    const { service, events, dns } = setup();
    const account = user('pro');

    await service.check('example.com', apiViewer(account), false);
    await service.check('example.com', apiViewer(account), false);
    dns.resolveAddresses.mockRejectedValue(new ProviderTimeoutError());
    await errorOf(service.check('slow.example.com', apiViewer(account), false));

    const recorded = (
      events.record.mock.calls as unknown as [
        string,
        { source: string; status: string; cacheHit: boolean; latency?: object },
      ][]
    ).map(([, event]) => event);
    expect(recorded.map((event) => event.source)).toEqual([
      'api',
      'api',
      'api',
    ]);
    expect(recorded.map((event) => [event.status, event.cacheHit])).toEqual([
      ['completed', false],
      ['completed', true],
      ['failed', false],
    ]);
    expect(recorded[0].latency).toBeDefined();
    expect(recorded[1].latency).toBeUndefined();
  });

  it('gives the owner the data their plan includes', async () => {
    const { service } = setup();

    const response = await service.check(
      'example.com',
      apiViewer(user('pro')),
      false,
    );

    expect(response.result.dns?.advanced.access).toBe('included');
    expect(JSON.stringify(response.result)).toContain(SECRET_MX);
  });

  it('rejects an invalid target before spending anything', async () => {
    const { service, usage } = setup();

    const error = await errorOf(
      service.check('ftp://nope', apiViewer(user('pro')), false),
    );

    expect(error.code).toBe('INVALID_INPUT');
    expect(usage.counters.size).toBe(0);
  });

  it('leaves signed-in web lookups exactly as they were', async () => {
    const { service, usage, store } = setup();

    const response = await service.check(
      'example.com',
      viewerOf(user('pro')),
      false,
    );

    expect(response.savedToHistory).toBe(true);
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(usage.counters.get('user:u_pro')).toBe(1);
    expect(usage.counters.get('api:u_pro')).toBeUndefined();
  });
});

describe('LookupService — abuse handling', () => {
  const apiViewer = (account: User): Viewer => ({
    user: account,
    ip: '198.51.100.7',
    apiKey: { id: 'key_1', environment: 'production' },
  });

  it('turns a blocked network away before doing any work', async () => {
    const { service, dns, usage } = setup({ blocked: true });

    const error = await errorOf(
      service.check('example.com', viewerOf(null, '203.0.113.50'), false),
    );

    expect(error.code).toBe('FORBIDDEN');
    expect(error.status).toBe(403);
    expect(dns.resolveAddresses).not.toHaveBeenCalled();
    expect(usage.counters.size).toBe(0);
  });

  it('asks about the visitor’s network, not the signed-in user', async () => {
    const { service, abuse } = setup();

    await service.check('example.com', viewerOf(null, '203.0.113.50'), false);
    await service.check('example.org', viewerOf(user('pro')), false);

    expect(abuse.isBlocked).toHaveBeenCalledTimes(1);
    expect(abuse.isBlocked).toHaveBeenCalledWith('visitor:203.0.113.50');
  });

  it('notes an anonymous visitor asking about internal targets, against their network', async () => {
    const { service, abuse } = setup();

    await errorOf(
      service.check('localhost', viewerOf(null, '203.0.113.50'), false),
    );
    await errorOf(
      service.check('10.0.0.1', viewerOf(null, '203.0.113.50'), false),
    );

    expect(abuse.note).toHaveBeenCalledTimes(2);
    expect(abuse.note).toHaveBeenCalledWith(
      'ip_address',
      'visitor:203.0.113.50',
      'internal_targets',
    );
  });

  it('notes a signed-in user asking about internal targets, against their account', async () => {
    const { service, abuse } = setup();

    await errorOf(
      service.check('169.254.169.254', viewerOf(user('pro')), false),
    );

    expect(abuse.note).toHaveBeenCalledWith(
      'account',
      'u_pro',
      'internal_targets',
    );
  });

  it('notes an API key’s owner the same way', async () => {
    const { service, abuse } = setup();

    await errorOf(service.check('192.168.1.1', apiViewer(user('pro')), false));

    expect(abuse.note).toHaveBeenCalledWith(
      'account',
      'u_pro',
      'internal_targets',
    );
  });

  it('does not note an ordinary typo', async () => {
    const { service, abuse } = setup();

    await errorOf(service.check('not a domain', viewerOf(null), false));
    await errorOf(service.check('ftp://nope', viewerOf(user('pro')), false));

    expect(abuse.note).not.toHaveBeenCalled();
  });

  it('notes an anonymous visitor who keeps asking after the daily limit', async () => {
    const { service, abuse } = setup();
    const visitor = viewerOf(null, '203.0.113.50');
    await service.check('one.example.com', visitor, false);
    await service.check('two.example.com', visitor, false);

    await errorOf(service.check('three.example.com', visitor, false));

    expect(abuse.note).toHaveBeenCalledWith(
      'ip_address',
      'visitor:203.0.113.50',
      'daily_limit_retries',
    );
  });

  it('does not treat a signed-in user reaching their monthly quota as abuse', async () => {
    const { service, abuse, usage } = setup();
    usage.counters.set('user:u_free', 100);

    const error = await errorOf(
      service.check('example.com', viewerOf(user('free')), false),
    );

    expect(error.code).toBe('QUOTA_EXCEEDED');
    expect(abuse.note).not.toHaveBeenCalled();
  });
});
