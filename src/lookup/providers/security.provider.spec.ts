import type { ConfigService } from '@nestjs/config';
import type { NetworkInfo } from '../../contracts';
import { ProviderUnavailableError } from './provider.types';
import {
  buildSecurityIntelligence,
  SecurityProvider,
  type AbuseIpdbReport,
} from './security.provider';
import type { TorExitListService } from './tor-exit-list.service';

const network = (overrides: Partial<NetworkInfo> = {}): NetworkInfo => ({
  asn: 64500,
  asnName: 'Example ISP',
  organization: 'Example ISP',
  isp: 'Example ISP',
  network: '203.0.113.0/24',
  connectionType: 'unknown',
  anycast: false,
  ...overrides,
});

const report = (overrides: Partial<AbuseIpdbReport> = {}): AbuseIpdbReport => ({
  abuseConfidenceScore: 0,
  usageType: 'Fixed Line ISP',
  isTor: false,
  totalReports: 0,
  lastReportedAt: null,
  reports: [],
  ...overrides,
});

const advancedOf = (result: ReturnType<typeof buildSecurityIntelligence>) => {
  if (result.advanced.access !== 'included') {
    throw new Error('expected advanced data');
  }
  return result.advanced.data;
};

describe('buildSecurityIntelligence', () => {
  it('reads a clean address as "clear" and says which sources were checked', () => {
    const result = buildSecurityIntelligence(report(), network(), false);

    expect(result.basic).toMatchObject({
      vpn: { state: 'clear' },
      proxy: { state: 'clear' },
      tor: { state: 'clear' },
      datacenter: { state: 'clear' },
    });
    const advanced = advancedOf(result);
    expect(advanced.reputation).toMatchObject({
      score: 0,
      level: 'low',
      categories: [],
    });
    expect(advanced.blacklists).toEqual({ checked: 2, listed: 0, entries: [] });
  });

  it('flags a VPN when abuse reports say so, with confidence from how many reports do', () => {
    const reports = [
      { reportedAt: '2026-09-01T00:00:00Z', categories: [13, 14] },
      { reportedAt: '2026-09-02T00:00:00Z', categories: [13] },
      { reportedAt: '2026-09-03T00:00:00Z', categories: [18] },
      { reportedAt: '2026-09-04T00:00:00Z', categories: [14] },
    ];
    const result = buildSecurityIntelligence(
      report({
        abuseConfidenceScore: 30,
        reports,
        totalReports: 4,
        lastReportedAt: '2026-09-04T00:00:00Z',
      }),
      network(),
      false,
    );

    expect(result.basic.vpn.state).toBe('detected'); // 2 of 4 reports = 50%
    expect(result.basic.vpn.summary).toMatch(/^2 recent abuse reports/);
    const advanced = advancedOf(result);
    expect(advanced.vpn.confidence).toBe(50);
    expect(advanced.reputation.categories).toEqual([
      'VPN IP',
      'Port Scan',
      'Brute-Force',
    ]);
    expect(advanced.reputation.lastReportedAt).toBe('2026-09-04T00:00:00Z');
  });

  it('only warns when a small share of reports mention proxies', () => {
    const reports = Array.from({ length: 10 }, (_, index) => ({
      reportedAt: '2026-09-01T00:00:00Z',
      categories: index === 0 ? [9] : [18],
    }));
    const result = buildSecurityIntelligence(
      report({ reports }),
      network(),
      false,
    );

    expect(result.basic.proxy.state).toBe('warning'); // 10%
    expect(advancedOf(result).proxy).toEqual({
      kind: 'public',
      confidence: 10,
    });
  });

  it('detects Tor from either the report or the exit list, and lists it as a blacklist entry', () => {
    const viaList = buildSecurityIntelligence(report(), network(), true);
    const viaReport = buildSecurityIntelligence(
      report({ isTor: true }),
      network(),
      false,
    );

    for (const result of [viaList, viaReport]) {
      expect(result.basic.tor.state).toBe('detected');
      expect(advancedOf(result).tor.role).toBe('exit');
      expect(
        advancedOf(result).blacklists.entries.map((entry) => entry.name),
      ).toContain('Tor exit node list');
    }
  });

  it('treats hosting networks as data-center, by usage type or by our own network classification', () => {
    expect(
      buildSecurityIntelligence(
        report({ usageType: 'Data Center/Web Hosting/Transit' }),
        network(),
        false,
      ).basic.datacenter.state,
    ).toBe('detected');
    expect(
      buildSecurityIntelligence(
        report(),
        network({ connectionType: 'datacenter' }),
        false,
      ).basic.datacenter.state,
    ).toBe('detected');
  });

  it.each([
    [0, 'low'],
    [24, 'low'],
    [25, 'medium'],
    [49, 'medium'],
    [50, 'high'],
    [74, 'high'],
    [75, 'critical'],
    [100, 'critical'],
  ])('maps confidence %i to risk level %s', (score, level) => {
    const result = buildSecurityIntelligence(
      report({ abuseConfidenceScore: score }),
      network(),
      false,
    );
    expect(advancedOf(result).reputation.level).toBe(level);
  });

  it('lists an address as blacklisted from confidence 50 up', () => {
    const below = buildSecurityIntelligence(
      report({ abuseConfidenceScore: 49 }),
      network(),
      false,
    );
    const above = buildSecurityIntelligence(
      report({ abuseConfidenceScore: 50 }),
      network(),
      false,
    );
    expect(advancedOf(below).blacklists.listed).toBe(0);
    expect(advancedOf(above).blacklists.listed).toBe(1);
  });

  it('never claims to detect residential proxies', () => {
    const advanced = advancedOf(
      buildSecurityIntelligence(report(), network(), false),
    );
    expect(advanced.residentialProxy.summary).toMatch(/isn't available/);
    expect(advanced.residentialProxy.confidence).toBe(0);
  });
});

describe('SecurityProvider', () => {
  const torList = { isExit: () => false } as unknown as TorExitListService;
  const withKey = (key?: string) =>
    new SecurityProvider(
      {
        get: (name: string) => (name === 'ABUSEIPDB_API_KEY' ? key : undefined),
      } as unknown as ConfigService,
      torList,
    );
  const signal = () => new AbortController().signal;

  afterEach(() => jest.restoreAllMocks());

  it('reports "not configured" instead of guessing when there is no API key', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await expect(
      withKey().assess('8.8.8.8', network(), signal()),
    ).rejects.toThrow(/not configured/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('calls AbuseIPDB with the key header and the address, and maps the answer', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        data: { ipAddress: '8.8.8.8', abuseConfidenceScore: 60, reports: [] },
      }),
    );

    const result = await withKey('secret-key').assess(
      '8.8.8.8',
      network(),
      signal(),
    );

    const [url, init] = fetchSpy.mock.calls[0];
    const urlText =
      typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    expect(urlText).toContain(
      'https://api.abuseipdb.com/api/v2/check?ipAddress=8.8.8.8',
    );
    expect(urlText).toContain('maxAgeInDays=90');
    expect(urlText).toContain('&verbose');
    expect((init?.headers as Record<string, string>).Key).toBe('secret-key');
    expect(advancedOf(result).reputation.score).toBe(60);
  });

  it.each([
    [429, /limiting requests/],
    [401, /not configured correctly/],
    [403, /not configured correctly/],
    [500, /not responding/],
  ])('turns HTTP %i into a readable "unavailable"', async (status, message) => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status }));
    const attempt = withKey('k').assess('8.8.8.8', network(), signal());
    await expect(attempt).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(attempt).rejects.toThrow(message);
  });

  it('rejects an unexpected response body', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ nope: true }));
    await expect(
      withKey('k').assess('8.8.8.8', network(), signal()),
    ).rejects.toThrow(/unexpected/);
  });
});
