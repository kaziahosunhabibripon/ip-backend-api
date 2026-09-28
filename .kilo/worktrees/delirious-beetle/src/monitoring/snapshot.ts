import type {
  DnsRecordType,
  DnsResolutionStatus,
  DomainCheckResult,
  RiskLevel,
  SignalState,
} from '../contracts';

export interface SnapshotRecord {
  type: DnsRecordType;
  name: string;
  value: string;
  priority?: number;
}

export interface SnapshotSecurity {
  vpn: SignalState;
  proxy: SignalState;
  tor: SignalState;
  /** 0 (clean) – 100 (abusive). */
  score: number | null;
  level: RiskLevel | null;
  /** How many blacklists carry the address. */
  listed: number | null;
}

export interface SnapshotAddressInfo {
  network: { asn: number; organization: string } | null;
  security: SnapshotSecurity | null;
}

/**
 * What a monitor remembers between runs — a small, comparable digest of a lookup rather than the whole
 * result. TTLs are deliberately left out: resolvers count them down, so two lookups a minute apart never
 * agree on them and comparing them would raise a false change every time.
 */
export interface MonitorSnapshot {
  takenAt: string;
  dnsStatus: DnsResolutionStatus | null;
  /** Every A/AAAA value the resolver returned (not only the few analysed), sorted. */
  addresses: string[];
  /** CNAME, MX, NS, TXT and SOA records. */
  records: SnapshotRecord[];
  /** PTR names, when the target is an IP address. */
  reverse: string[] | null;
  /** What was learned about each analysed address. */
  intel: Record<string, SnapshotAddressInfo>;
}

const ADDRESS_TYPES: ReadonlySet<DnsRecordType> = new Set(['A', 'AAAA']);

const byKey = (left: SnapshotRecord, right: SnapshotRecord) =>
  left.type.localeCompare(right.type) ||
  left.name.localeCompare(right.name) ||
  (left.priority ?? 0) - (right.priority ?? 0) ||
  left.value.localeCompare(right.value);

/**
 * Digests a full lookup. When part of it could not be read this time (a provider was down), that part is
 * carried over from `previous` instead of being recorded as empty — otherwise a resolver hiccup would look
 * like every MX record, or a whole reputation score, vanishing.
 */
export const buildSnapshot = (
  result: DomainCheckResult,
  previous: MonitorSnapshot | null,
): MonitorSnapshot => {
  // `providers.dns` is the worst of the lookups that fed the DNS section, including the advanced one.
  const dnsComplete = result.providers.dns.status === 'ok';

  const basic: SnapshotRecord[] = [];
  const addresses = new Set<string>();
  for (const record of result.dns?.records ?? []) {
    if (ADDRESS_TYPES.has(record.type)) {
      addresses.add(record.value.toLowerCase());
    } else {
      basic.push({ type: record.type, name: record.name, value: record.value });
    }
  }

  const advanced: SnapshotRecord[] =
    result.dns?.advanced.access === 'included'
      ? result.dns.advanced.data.map((record) => ({
          type: record.type,
          name: record.name,
          value: record.value,
          ...(record.priority === undefined
            ? {}
            : { priority: record.priority }),
        }))
      : [];

  const carriedAdvanced = (previous?.records ?? []).filter(
    (record) => record.type !== 'CNAME',
  );

  let reverse: string[] | null = null;
  if (result.type !== 'domain') {
    reverse =
      dnsComplete && result.reverseDns?.access === 'included'
        ? [...result.reverseDns.data].sort()
        : (previous?.reverse ?? null);
  }

  const intel: Record<string, SnapshotAddressInfo> = {};
  for (const ip of result.ips) {
    const before = previous?.intel[ip.ip];

    let security: SnapshotSecurity | null = before?.security ?? null;
    if (ip.security.status === 'ok') {
      const { basic: flags, advanced: detail } = ip.security.data;
      const reputation =
        detail.access === 'included' ? detail.data.reputation : null;
      security = {
        vpn: flags.vpn.state,
        proxy: flags.proxy.state,
        tor: flags.tor.state,
        score: reputation?.score ?? null,
        level: reputation?.level ?? null,
        listed:
          detail.access === 'included' ? detail.data.blacklists.listed : null,
      };
    }

    intel[ip.ip] = {
      network:
        ip.network.status === 'ok'
          ? {
              asn: ip.network.data.asn,
              organization: ip.network.data.organization,
            }
          : (before?.network ?? null),
      security,
    };
  }

  return {
    takenAt: result.checkedAt,
    dnsStatus: result.dns?.status ?? null,
    addresses: [...addresses].sort(),
    records: [...basic, ...(dnsComplete ? advanced : carriedAdvanced)].sort(
      byKey,
    ),
    reverse,
    intel,
  };
};
