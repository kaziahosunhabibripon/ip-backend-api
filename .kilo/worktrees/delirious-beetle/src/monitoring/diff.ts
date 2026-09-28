import type { AlertDraft } from '../alerts/alert-draft';
import { maxSeverity } from '../alerts/severity';
import type {
  AlertCategory,
  AlertSeverity,
  AlertType,
  MonitorWatch,
  SignalState,
} from '../contracts';
import type {
  MonitorSnapshot,
  SnapshotRecord,
  SnapshotSecurity,
} from './snapshot';

export interface Change {
  watch: MonitorWatch;
  severity: AlertSeverity;
  /** One plain sentence for the alert message. */
  text: string;
}

/** "a, b, c and 2 more" — an alert is a glance, not a dump. */
const some = (items: string[], shown = 3) =>
  items.length <= shown
    ? items.join(', ')
    : `${items.slice(0, shown).join(', ')} and ${items.length - shown} more`;

const clip = (value: string, length = 60) =>
  value.length > length ? `${value.slice(0, length - 1)}…` : value;

const plural = (count: number, one: string, many: string) =>
  count === 1 ? one : many;

const minus = <T>(from: T[], remove: T[]) => {
  const drop = new Set(remove);
  return from.filter((item) => !drop.has(item));
};

// ---------------------------------------------------------------------- IP

const diffAddresses = (
  before: MonitorSnapshot,
  after: MonitorSnapshot,
): Change[] => {
  const added = minus(after.addresses, before.addresses);
  const removed = minus(before.addresses, after.addresses);
  if (added.length === 0 && removed.length === 0) {
    return [];
  }

  const named = (ip: string) => {
    const owner = after.intel[ip]?.network?.organization;
    return owner ? `${ip} (${owner})` : ip;
  };

  if (after.addresses.length === 0) {
    return [
      {
        watch: 'ip',
        severity: 'high',
        text:
          after.dnsStatus === 'nxdomain'
            ? `The domain no longer exists (NXDOMAIN). It used to resolve to ${some(removed)}.`
            : `The domain no longer resolves to any address. It used to resolve to ${some(removed)}.`,
      },
    ];
  }

  const parts: string[] = [];
  if (added.length > 0) {
    parts.push(
      `New ${plural(added.length, 'address', 'addresses')}: ${some(added.map(named))}.`,
    );
  }
  if (removed.length > 0) {
    parts.push(
      `${plural(removed.length, 'Address', 'Addresses')} no longer returned: ${some(removed)}.`,
    );
  }

  // Everything it used to point at is gone: a move, or a takeover — worth more attention than one node rotating.
  const replaced = minus(before.addresses, removed).length === 0;
  return [
    {
      watch: 'ip',
      severity: replaced ? 'high' : 'medium',
      text: parts.join(' '),
    },
  ];
};

// --------------------------------------------------------------------- DNS

const recordKey = (record: SnapshotRecord) =>
  `${record.type}|${record.name}|${record.priority ?? ''}|${record.value}`;

/** A resolver can repeat a record; two identical ones are one record, not two changes. */
const distinct = (records: SnapshotRecord[]) => [
  ...new Map(records.map((record) => [recordKey(record), record])).values(),
];

const describeRecord = (record: SnapshotRecord) =>
  record.type === 'MX'
    ? `${record.priority ?? 0} ${record.value}`
    : clip(record.value);

const SEVERITY_BY_TYPE: Partial<Record<SnapshotRecord['type'], AlertSeverity>> =
  {
    NS: 'high',
    MX: 'medium',
    CNAME: 'medium',
    TXT: 'low',
    SOA: 'info',
  };

const RECORD_LABEL: Partial<Record<SnapshotRecord['type'], string>> = {
  NS: 'Nameservers',
  MX: 'Mail servers (MX)',
  CNAME: 'CNAME',
  TXT: 'TXT records',
  SOA: 'SOA record',
};

const soaSerial = (record: SnapshotRecord | undefined) =>
  record?.value.split(' ')[2];

const diffRecords = (
  before: MonitorSnapshot,
  after: MonitorSnapshot,
): Change[] => {
  const changes: Change[] = [];
  const types = new Set(
    [...before.records, ...after.records].map((r) => r.type),
  );

  for (const type of types) {
    const old = distinct(
      before.records.filter((record) => record.type === type),
    );
    const now = distinct(
      after.records.filter((record) => record.type === type),
    );
    const oldKeys = old.map(recordKey);
    const nowKeys = now.map(recordKey);
    const added = now.filter((record) => !oldKeys.includes(recordKey(record)));
    const removed = old.filter(
      (record) => !nowKeys.includes(recordKey(record)),
    );
    if (added.length === 0 && removed.length === 0) {
      continue;
    }

    const severity = SEVERITY_BY_TYPE[type] ?? 'low';
    const label = RECORD_LABEL[type] ?? `${type} records`;

    if (type === 'SOA') {
      const from = soaSerial(removed[0]);
      const to = soaSerial(added[0]);
      changes.push({
        watch: 'dns',
        severity,
        text:
          from && to && from !== to
            ? `The zone's SOA serial changed from ${from} to ${to}.`
            : 'The SOA record changed.',
      });
      continue;
    }

    const parts: string[] = [];
    if (added.length > 0) {
      parts.push(`added ${some(added.map(describeRecord))}`);
    }
    if (removed.length > 0) {
      parts.push(`removed ${some(removed.map(describeRecord))}`);
    }
    changes.push({
      watch: 'dns',
      severity,
      text: `${label} changed: ${parts.join('; ')}.`,
    });
  }

  return changes;
};

const diffReverse = (
  before: MonitorSnapshot,
  after: MonitorSnapshot,
): Change[] => {
  if (before.reverse === null || after.reverse === null) {
    return [];
  }
  const added = minus(after.reverse, before.reverse);
  const removed = minus(before.reverse, after.reverse);
  if (added.length === 0 && removed.length === 0) {
    return [];
  }

  const parts: string[] = [];
  if (added.length > 0) {
    parts.push(`added ${some(added)}`);
  }
  if (removed.length > 0) {
    parts.push(`removed ${some(removed)}`);
  }
  return [
    {
      watch: 'dns',
      severity: 'low',
      text: `Reverse DNS (PTR) changed: ${parts.join('; ')}.`,
    },
  ];
};

// ---------------------------------------------------------------- provider

const diffProvider = (
  before: MonitorSnapshot,
  after: MonitorSnapshot,
): Change[] => {
  const changes: Change[] = [];
  for (const [ip, info] of Object.entries(after.intel)) {
    const was = before.intel[ip]?.network;
    const now = info.network;
    if (!was || !now) {
      continue;
    }

    if (was.asn !== now.asn) {
      changes.push({
        watch: 'provider',
        severity: 'medium',
        text: `${ip} moved to a different network: AS${was.asn} (${was.organization}) → AS${now.asn} (${now.organization}).`,
      });
    } else if (was.organization !== now.organization) {
      changes.push({
        watch: 'provider',
        severity: 'info',
        text: `The registered organization for ${ip} changed from ${was.organization} to ${now.organization}.`,
      });
    }
  }
  return changes;
};

// ---------------------------------------------------------------- security

const SIGNAL_LABEL = { vpn: 'VPN', proxy: 'Proxy', tor: 'Tor' } as const;

const signalSeverity = (
  kind: keyof typeof SIGNAL_LABEL,
  to: SignalState,
): AlertSeverity => {
  if (to === 'clear') {
    return 'info';
  }
  if (to === 'warning') {
    return 'low';
  }
  return kind === 'tor' ? 'high' : 'medium';
};

/** Small drifts in a reputation score aren't news; a jump, or crossing into another risk band, is. */
const SCORE_JUMP = 15;

const diffSecurityOf = (
  ip: string,
  was: SnapshotSecurity,
  now: SnapshotSecurity,
): Change[] => {
  const changes: Change[] = [];

  for (const kind of Object.keys(
    SIGNAL_LABEL,
  ) as (keyof typeof SIGNAL_LABEL)[]) {
    if (was[kind] !== now[kind]) {
      const verb =
        now[kind] === 'clear'
          ? 'cleared'
          : now[kind] === 'warning'
            ? 'raised a warning'
            : 'was detected';
      changes.push({
        watch: 'security',
        severity: signalSeverity(kind, now[kind]),
        text: `${SIGNAL_LABEL[kind]} signal ${verb} for ${ip} (was ${was[kind]}).`,
      });
    }
  }

  if (was.score !== null && now.score !== null) {
    const moved = now.score - was.score;
    if (Math.abs(moved) >= SCORE_JUMP || was.level !== now.level) {
      const worse = moved > 0;
      changes.push({
        watch: 'security',
        severity: worse
          ? now.level === 'critical'
            ? 'critical'
            : now.level === 'high'
              ? 'high'
              : 'medium'
          : 'info',
        text: `Reputation score for ${ip} ${worse ? 'rose' : 'fell'} from ${was.score} to ${now.score}${now.level ? ` (${now.level} risk)` : ''}.`,
      });
    }
  }

  if (was.listed !== null && now.listed !== null && was.listed !== now.listed) {
    changes.push({
      watch: 'security',
      severity:
        was.listed === 0 ? 'high' : now.listed === 0 ? 'info' : 'medium',
      text:
        was.listed === 0
          ? `${ip} was added to ${now.listed} ${plural(now.listed, 'blacklist', 'blacklists')}.`
          : now.listed === 0
            ? `${ip} was removed from every blacklist it was on.`
            : `${ip} is now on ${now.listed} ${plural(now.listed, 'blacklist', 'blacklists')} (was ${was.listed}).`,
    });
  }

  return changes;
};

const diffSecurity = (
  before: MonitorSnapshot,
  after: MonitorSnapshot,
): Change[] =>
  Object.entries(after.intel).flatMap(([ip, info]) => {
    const was = before.intel[ip]?.security;
    return was && info.security ? diffSecurityOf(ip, was, info.security) : [];
  });

// -------------------------------------------------------------------- main

/**
 * What changed between two snapshots, limited to the kinds the monitor watches. Only addresses present
 * in both snapshots are compared for provider and security changes: a new address is already reported
 * as an IP change, and comparing it with nothing would only repeat that.
 */
export const diffSnapshots = (
  before: MonitorSnapshot,
  after: MonitorSnapshot,
  watch: readonly MonitorWatch[],
): Change[] => {
  const wanted = new Set(watch);
  return [
    ...(wanted.has('ip') ? diffAddresses(before, after) : []),
    ...(wanted.has('dns')
      ? [...diffRecords(before, after), ...diffReverse(before, after)]
      : []),
    ...(wanted.has('provider') ? diffProvider(before, after) : []),
    ...(wanted.has('security') ? diffSecurity(before, after) : []),
  ];
};

// ------------------------------------------------------------------ alerts

const KIND: Record<MonitorWatch, { type: AlertType; category: AlertCategory }> =
  {
    dns: { type: 'dns_changed', category: 'dns' },
    ip: { type: 'ip_changed', category: 'network' },
    provider: { type: 'ip_changed', category: 'network' },
    security: { type: 'security_changed', category: 'security' },
  };

/** One alert per kind of change, so a run that moves both the IPs and the nameservers reads as two things. */
export const draftAlerts = (changes: Change[]): AlertDraft[] => {
  const kinds: MonitorWatch[] = ['security', 'dns', 'ip', 'provider'];
  return kinds.flatMap((watch) => {
    const group = changes.filter((change) => change.watch === watch);
    if (group.length === 0) {
      return [];
    }
    return [
      {
        ...KIND[watch],
        watch,
        severity: maxSeverity(group.map((change) => change.severity)),
        message: group.map((change) => change.text).join(' '),
        summary:
          group.length === 1
            ? clip(group[0].text, 120)
            : `${clip(group[0].text, 100)} (+${group.length - 1} more)`,
      },
    ];
  });
};

/** Keeps only the kinds of change that showed up in both looks, taking the wording from the later one. */
export const confirmedChanges = (
  first: Change[],
  second: Change[],
): Change[] => {
  const seen = new Set(first.map((change) => change.watch));
  return second.filter((change) => seen.has(change.watch));
};
