import type { DomainCheckResult, IPIntelligence } from '../contracts';
import {
  BULK_HARD_CAP,
  advertisedBatchSize,
  batchLimitFor,
  countsFrom,
  prepareEntries,
  summarize,
  toBulkJob,
} from './bulk-rules';

describe('batchLimitFor', () => {
  it('follows the plan, with a hard cap where the plan is negotiated', () => {
    expect(batchLimitFor('free')).toBe(0);
    expect(batchLimitFor('pro')).toBe(100);
    expect(batchLimitFor('business')).toBe(1_000);
    expect(batchLimitFor('enterprise')).toBe(BULK_HARD_CAP);
  });

  it('tells clients null for a negotiated size instead of the internal cap', () => {
    expect(advertisedBatchSize('enterprise')).toBeNull();
    expect(advertisedBatchSize('pro')).toBe(100);
  });
});

describe('prepareEntries', () => {
  it('numbers the kept lines from 1 in the order given', () => {
    const { items } = prepareEntries(['example.com', '8.8.8.8', 'github.com']);
    expect(items.map((i) => [i.position, i.target, i.type])).toEqual([
      [1, 'example.com', 'domain'],
      [2, '8.8.8.8', 'ipv4'],
      [3, 'github.com', 'domain'],
    ]);
    expect(items.every((i) => i.status === 'pending')).toBe(true);
  });

  it('drops blank entries without counting them as repeats', () => {
    const result = prepareEntries(['', '   ', 'example.com', '\t']);
    expect(result.items).toHaveLength(1);
    expect(result.duplicates).toBe(0);
  });

  it('normalises before comparing, so a URL and a bare domain are one line', () => {
    const result = prepareEntries([
      'https://Example.com/path?x=1',
      'example.com',
      'EXAMPLE.COM',
    ]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].input).toBe('https://Example.com/path?x=1');
    expect(result.items[0].target).toBe('example.com');
    expect(result.duplicates).toBe(2);
  });

  it('keeps a bad line, marked invalid with the reason, and still numbers it', () => {
    const { items } = prepareEntries([
      'example.com',
      'not a domain',
      '1.1.1.1',
    ]);
    expect(items.map((i) => [i.position, i.status])).toEqual([
      [1, 'pending'],
      [2, 'invalid'],
      [3, 'pending'],
    ]);
    expect(items[1]).toMatchObject({
      target: null,
      type: null,
      error: { code: 'INVALID_INPUT' },
      internal: false,
    });
    expect(items[1].error?.message).toMatch(/valid domain or IP/);
  });

  it('flags internal addresses so they can be reported, and never queues them', () => {
    const { items } = prepareEntries([
      '10.0.0.1',
      'localhost',
      'printer.local',
    ]);
    expect(items.every((i) => i.status === 'invalid' && i.internal)).toBe(true);
  });

  it('counts a repeated bad line once', () => {
    const result = prepareEntries(['nope!', 'nope!']);
    expect(result.items).toHaveLength(1);
    expect(result.duplicates).toBe(1);
  });
});

const ip = (overrides: Partial<IPIntelligence> = {}): IPIntelligence => ({
  ip: '93.184.216.34',
  version: 4,
  geo: {
    status: 'ok',
    data: {
      country: 'United States',
      countryCode: 'US',
      region: 'California',
      city: 'Los Angeles',
      timezone: 'America/Los_Angeles',
      latitude: 0,
      longitude: 0,
      accuracyRadiusKm: 100,
    },
  },
  network: {
    status: 'ok',
    data: {
      asn: 15133,
      asnName: 'EDGECAST',
      organization: 'Edgecast Inc.',
      isp: 'Edgecast',
      network: '93.184.216.0/24',
      connectionType: 'cdn',
      anycast: false,
    },
  },
  security: {
    status: 'ok',
    data: {
      basic: {
        vpn: { state: 'clear', summary: '' },
        proxy: { state: 'warning', summary: '' },
        tor: { state: 'clear', summary: '' },
        datacenter: { state: 'detected', summary: '' },
      },
      advanced: {
        access: 'included',
        data: {
          vpn: { confidence: 0 },
          proxy: { confidence: 0 },
          tor: {},
          residentialProxy: { state: 'clear', summary: '', confidence: 0 },
          reputation: { score: 12, level: 'low', categories: [] },
          blacklists: { checked: 0, listed: 0, entries: [] },
        },
      },
    },
  },
  ...overrides,
});

const resultWith = (ips: IPIntelligence[]) =>
  ({ status: 'completed', ips }) as unknown as DomainCheckResult;

describe('summarize', () => {
  it('takes the headline from the first address and lists all of them', () => {
    const second = ip({ ip: '93.184.216.35' });
    expect(summarize(resultWith([ip(), second]))).toEqual({
      ips: ['93.184.216.34', '93.184.216.35'],
      country: 'United States',
      city: 'Los Angeles',
      asn: 15133,
      organization: 'Edgecast Inc.',
      connectionType: 'cdn',
      riskScore: 12,
      riskLevel: 'low',
      vpn: 'clear',
      proxy: 'warning',
      tor: 'clear',
      datacenter: 'detected',
    });
  });

  it('leaves out whatever a provider could not deliver instead of inventing it', () => {
    const partial = ip({
      geo: { status: 'timeout' },
      network: { status: 'unavailable' },
      security: { status: 'unavailable' },
    });
    expect(summarize(resultWith([partial]))).toEqual({
      ips: ['93.184.216.34'],
      country: null,
      city: null,
      asn: null,
      organization: null,
      connectionType: null,
      riskScore: null,
      riskLevel: null,
      vpn: null,
      proxy: null,
      tor: null,
      datacenter: null,
    });
  });

  it('gives no risk score when the reputation section is locked', () => {
    const locked = ip();
    if (locked.security.status === 'ok') {
      locked.security.data.advanced = { access: 'locked', requiredPlan: 'pro' };
    }
    const summary = summarize(resultWith([locked]));
    expect(summary.riskScore).toBeNull();
    expect(summary.vpn).toBe('clear');
  });

  it('copes with a lookup that found no addresses', () => {
    expect(summarize(resultWith([])).ips).toEqual([]);
  });
});

describe('job counts', () => {
  it('folds statuses into the numbers a job shows', () => {
    expect(
      countsFrom({
        pending: 4,
        completed: 5,
        partial: 2,
        no_records: 1,
        failed: 3,
        invalid: 2,
        skipped: 6,
      }),
    ).toEqual({ processed: 19, succeeded: 8, failed: 5, skipped: 6 });
  });

  it('builds a job whose total includes the pending lines', () => {
    const now = new Date('2026-09-27T10:00:00.000Z');
    const job = toBulkJob(
      {
        id: 'j1',
        name: null,
        status: 'running',
        duplicates: 2,
        stoppedReason: null,
        createdAt: now,
        startedAt: now,
        finishedAt: null,
      },
      { pending: 3, completed: 7 },
    );
    expect(job).toMatchObject({
      total: 10,
      processed: 7,
      succeeded: 7,
      failed: 0,
      skipped: 0,
      duplicates: 2,
      startedAt: '2026-09-27T10:00:00.000Z',
      finishedAt: null,
    });
  });
});
