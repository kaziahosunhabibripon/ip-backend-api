import { Injectable } from '@nestjs/common';
import { getDomain } from 'tldts';
import type {
  DNSRecord,
  DnsRecordType,
  DnsResolutionStatus,
} from '../../contracts';
import { reverseDnsName } from '../normalizer/ip-address';
import { ProviderUnavailableError } from './provider.types';

export interface ResolvedAddress {
  ip: string;
  version: 4 | 6;
  source: 'A' | 'AAAA';
}

export interface DnsLookup {
  status: DnsResolutionStatus;
  /** Which public resolver answered, e.g. "1.1.1.1". */
  resolver: string;
  /** CNAME, A and AAAA records — shown to everyone. */
  records: DNSRecord[];
  addresses: ResolvedAddress[];
}

interface DohAnswer {
  name: string;
  type: number;
  TTL: number;
  data: string;
}

interface DohResponse {
  Status: number;
  Answer?: DohAnswer[];
}

interface DohResult {
  rcode: number;
  answers: DohAnswer[];
  resolver: string;
}

const TYPE = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
};
const RCODE = { SERVFAIL: 2, NXDOMAIN: 3, REFUSED: 5 };

/** Tried in order; the second only answers when the first can't. */
const RESOLVERS = [
  { label: '1.1.1.1', url: 'https://cloudflare-dns.com/dns-query' },
  { label: '8.8.8.8', url: 'https://dns.google/resolve' },
];

const clean = (name: string) => name.replace(/\.$/, '').toLowerCase();

/** TXT data arrives as one or more quoted chunks: `"v=spf1 " "include:x"` -> `v=spf1 include:x`. */
const unquoteTxt = (data: string) => {
  const chunks = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) =>
    match[1].replace(/\\(.)/g, '$1'),
  );
  return chunks.length > 0 ? chunks.join('') : data;
};

/**
 * DNS through public DNS-over-HTTPS resolvers rather than the OS resolver: it exposes real TTLs and
 * response codes (NXDOMAIN vs SERVFAIL vs no data), works where outbound UDP/53 is blocked, and
 * gives us a second resolver to fall back to. The target only ever travels as a query parameter to
 * these fixed hosts, so a user-supplied name can't redirect the request anywhere else.
 */
@Injectable()
export class DnsProvider {
  /** A + AAAA (with the CNAME chain the resolver returns alongside them). */
  async resolveAddresses(
    domain: string,
    signal: AbortSignal,
  ): Promise<DnsLookup> {
    const [a, aaaa] = await Promise.allSettled([
      this.query(domain, TYPE.A, signal),
      this.query(domain, TYPE.AAAA, signal),
    ]);
    if (a.status === 'rejected' && aaaa.status === 'rejected') {
      throw a.reason;
    }

    const answered = [a, aaaa].flatMap((outcome) =>
      outcome.status === 'fulfilled' ? [outcome.value] : [],
    );
    const seen = new Set<string>();
    const records: DNSRecord[] = [];
    const addresses: ResolvedAddress[] = [];

    const add = (answer: DohAnswer, type: DnsRecordType) => {
      const record: DNSRecord = {
        id: '',
        type,
        name: clean(answer.name),
        value:
          type === 'CNAME' ? clean(answer.data) : answer.data.toLowerCase(),
        ttl: answer.TTL,
      };
      const key = `${type}|${record.name}|${record.value}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      record.id = `${type.toLowerCase()}_${records.length}`;
      records.push(record);
      return true;
    };

    // The CNAME chain comes back on both queries; keep it first and once.
    for (const { answers } of answered) {
      answers
        .filter((answer) => answer.type === TYPE.CNAME)
        .forEach((answer) => add(answer, 'CNAME'));
    }
    for (const { answers } of answered) {
      for (const answer of answers) {
        if (answer.type === TYPE.A && add(answer, 'A')) {
          addresses.push({ ip: answer.data, version: 4, source: 'A' });
        } else if (answer.type === TYPE.AAAA && add(answer, 'AAAA')) {
          addresses.push({
            ip: answer.data.toLowerCase(),
            version: 6,
            source: 'AAAA',
          });
        }
      }
    }

    const rcodes = answered.map((outcome) => outcome.rcode);
    let status: DnsResolutionStatus = 'no_records';
    if (records.length > 0) {
      status = 'resolved';
    } else if (rcodes.includes(RCODE.NXDOMAIN)) {
      status = 'nxdomain';
    } else if (
      rcodes.some((code) => code === RCODE.SERVFAIL || code === RCODE.REFUSED)
    ) {
      status = 'servfail';
    }

    return { status, resolver: answered[0].resolver, records, addresses };
  }

  /** MX, NS, TXT and SOA at the registrable domain (Pro and above). */
  async resolveAdvanced(
    domain: string,
    signal: AbortSignal,
  ): Promise<DNSRecord[]> {
    const apex = getDomain(domain) ?? domain;
    const wanted: [DnsRecordType, number][] = [
      ['MX', TYPE.MX],
      ['NS', TYPE.NS],
      ['TXT', TYPE.TXT],
      ['SOA', TYPE.SOA],
    ];
    const outcomes = await Promise.allSettled(
      wanted.map(([, type]) => this.query(apex, type, signal)),
    );
    if (outcomes.every((outcome) => outcome.status === 'rejected')) {
      throw outcomes[0].reason;
    }

    const records: DNSRecord[] = [];
    wanted.forEach(([recordType, type], index) => {
      const outcome = outcomes[index];
      if (outcome.status !== 'fulfilled') {
        return;
      }
      for (const answer of outcome.value.answers) {
        if (answer.type !== type) {
          continue;
        }
        const record: DNSRecord = {
          id: `${recordType.toLowerCase()}_${records.length}`,
          type: recordType,
          name: clean(answer.name),
          value: answer.data,
          ttl: answer.TTL,
        };
        if (recordType === 'MX') {
          const [priority, host] = answer.data.split(' ');
          record.priority = Number(priority);
          record.value = clean(host ?? '');
        } else if (recordType === 'NS') {
          record.value = clean(answer.data);
        } else if (recordType === 'TXT') {
          record.value = unquoteTxt(answer.data);
        } else {
          record.value = answer.data
            .split(' ')
            .map((part, position) => (position < 2 ? clean(part) : part))
            .join(' ');
        }
        records.push(record);
      }
    });

    return records.sort(
      (left, right) =>
        left.type.localeCompare(right.type) ||
        (left.priority ?? 0) - (right.priority ?? 0),
    );
  }

  /** PTR names for an address; empty when it has none. */
  async reverse(ip: string, signal: AbortSignal): Promise<string[]> {
    const name = reverseDnsName(ip);
    if (!name) {
      return [];
    }

    const { answers } = await this.query(name, TYPE.PTR, signal);
    return answers
      .filter((answer) => answer.type === TYPE.PTR)
      .map((answer) => clean(answer.data));
  }

  private async query(
    name: string,
    type: number,
    signal: AbortSignal,
  ): Promise<DohResult> {
    for (const resolver of RESOLVERS) {
      try {
        const url = new URL(resolver.url);
        url.searchParams.set('name', name);
        url.searchParams.set('type', String(type));

        const response = await fetch(url, {
          headers: { accept: 'application/dns-json' },
          signal,
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const body = (await response.json()) as DohResponse;
        return {
          rcode: body.Status,
          answers: body.Answer ?? [],
          resolver: resolver.label,
        };
      } catch (error) {
        // Out of time overall — trying another resolver would only run past the deadline.
        if (signal.aborted) {
          throw error;
        }
      }
    }

    throw new ProviderUnavailableError('DNS resolvers are not responding.');
  }
}
