import type {
  DNSRecord,
  DnsResolutionStatus,
  DomainCheckResult,
  InputType,
  IPIntelligence,
  ProviderState,
  ProviderStatusMap,
  RiskLevel,
  SignalState,
} from '../contracts';

/**
 * Test-only builder for lookup results. The name ends in `spec.ts` so the build leaves it out, but not in
 * `.spec.ts`, so Jest doesn't mistake it for a test file.
 */
export interface FixtureSecurity {
  vpn?: SignalState;
  proxy?: SignalState;
  tor?: SignalState;
  score?: number;
  level?: RiskLevel;
  listed?: number;
}

export interface FixtureAddress {
  ip: string;
  asn?: number;
  org?: string;
  /** Omit for a clean address; 'unavailable' for a provider that didn't answer. */
  security?: FixtureSecurity | 'unavailable';
  network?: 'unavailable';
}

export interface FixtureOptions {
  target?: string;
  type?: InputType;
  addresses?: FixtureAddress[];
  /** CNAME records in front of the addresses. */
  cnames?: { name: string; value: string }[];
  /** MX, NS, TXT and SOA records; 'failed' when that lookup didn't come back. */
  advanced?: Omit<DNSRecord, 'id' | 'ttl'>[] | 'failed';
  dnsStatus?: DnsResolutionStatus;
  /** PTR names for an IP target; 'failed' when the lookup didn't come back. */
  reverse?: string[] | 'failed';
  /** TTL stamped on every record — resolvers count it down, so tests vary it. */
  ttl?: number;
  checkedAt?: string;
}

const ok: ProviderState = { status: 'ok', latencyMs: 5 };
const down: ProviderState = { status: 'unavailable', message: 'down' };

export const checkResult = (
  options: FixtureOptions = {},
): DomainCheckResult => {
  const type = options.type ?? 'domain';
  const target =
    options.target ?? (type === 'domain' ? 'example.com' : '1.1.1.1');
  const addresses = options.addresses ?? [];
  const ttl = options.ttl ?? 300;

  const advancedFailed = options.advanced === 'failed';
  const reverseFailed = options.reverse === 'failed';
  const dnsProvider = advancedFailed || reverseFailed ? down : ok;

  const records: DNSRecord[] = [
    ...(options.cnames ?? []).map((cname, index) => ({
      id: `cname_${index}`,
      type: 'CNAME' as const,
      name: cname.name,
      value: cname.value,
      ttl,
    })),
    ...addresses.map((address, index) => ({
      id: `a_${index}`,
      type: address.ip.includes(':') ? ('AAAA' as const) : ('A' as const),
      name: target,
      value: address.ip,
      ttl,
    })),
  ];

  const advanced: DNSRecord[] = Array.isArray(options.advanced)
    ? options.advanced.map((record, index) => ({
        ...record,
        id: `adv_${index}`,
        ttl,
      }))
    : [];

  const ips: IPIntelligence[] = (
    type === 'domain' ? addresses : [{ ip: target } as FixtureAddress]
  ).map((address) => {
    const security = address.security;
    return {
      ip: address.ip,
      version: address.ip.includes(':') ? 6 : 4,
      geo: { status: 'unavailable', message: 'not needed here' },
      network:
        address.network === 'unavailable'
          ? { status: 'unavailable', message: 'down' }
          : {
              status: 'ok',
              data: {
                asn: address.asn ?? 13335,
                asnName: `AS${address.asn ?? 13335}`,
                organization: address.org ?? 'Cloudflare, Inc.',
                isp: address.org ?? 'Cloudflare, Inc.',
                network: '1.1.1.0/24',
                connectionType: 'cdn',
                anycast: false,
              },
            },
      security:
        security === 'unavailable'
          ? { status: 'unavailable', message: 'no key' }
          : {
              status: 'ok',
              data: {
                basic: {
                  vpn: { state: security?.vpn ?? 'clear', summary: '' },
                  proxy: { state: security?.proxy ?? 'clear', summary: '' },
                  tor: { state: security?.tor ?? 'clear', summary: '' },
                  datacenter: { state: 'clear', summary: '' },
                },
                advanced: {
                  access: 'included',
                  data: {
                    vpn: { confidence: 0 },
                    proxy: { confidence: 0 },
                    tor: {},
                    residentialProxy: {
                      state: 'clear',
                      summary: '',
                      confidence: 0,
                    },
                    reputation: {
                      score: security?.score ?? 0,
                      level: security?.level ?? 'low',
                      categories: [],
                    },
                    blacklists: {
                      checked: 60,
                      listed: security?.listed ?? 0,
                      entries: [],
                    },
                  },
                },
              },
            },
    };
  });

  const providers: ProviderStatusMap = {
    dns: dnsProvider,
    geo: ok,
    asn: ok,
    security: ok,
  };

  return {
    id: 'chk_fixture',
    input: target,
    target,
    type,
    status: 'completed',
    checkedAt: options.checkedAt ?? '2026-09-24T12:00:00.000Z',
    durationMs: 100,
    cache: { hit: false },
    dns:
      type === 'domain'
        ? {
            status: options.dnsStatus ?? 'resolved',
            resolver: '1.1.1.1',
            latencyMs: 20,
            records,
            advanced: {
              access: 'included',
              data: advancedFailed ? [] : advanced,
            },
          }
        : null,
    ips,
    providers,
    reverseDns:
      type === 'domain'
        ? null
        : {
            access: 'included',
            data: Array.isArray(options.reverse) ? options.reverse : [],
          },
  };
};
