import type { MonitorWatch } from '../contracts';
import { checkResult, type FixtureOptions } from './check-result.fixture-spec';
import {
  confirmedChanges,
  diffSnapshots,
  draftAlerts,
  type Change,
} from './diff';
import { buildSnapshot } from './snapshot';

const ALL: MonitorWatch[] = ['dns', 'ip', 'provider', 'security'];

const snap = (options: FixtureOptions) =>
  buildSnapshot(checkResult(options), null);

const MX = {
  type: 'MX' as const,
  name: 'example.com',
  value: 'mail.example.com',
  priority: 10,
};
const NS = {
  type: 'NS' as const,
  name: 'example.com',
  value: 'ns1.example.net',
};
const SOA = (serial: number) => ({
  type: 'SOA' as const,
  name: 'example.com',
  value: `ns1.example.net hostmaster.example.com ${serial} 7200 3600 1209600 300`,
});

describe('diffSnapshots — IP addresses', () => {
  const before = snap({ addresses: [{ ip: '1.1.1.1' }, { ip: '2.2.2.2' }] });

  it('reports nothing when nothing changed', () => {
    expect(diffSnapshots(before, before, ALL)).toEqual([]);
  });

  it('reports a new address with its owner, at medium when others stay', () => {
    const after = snap({
      addresses: [
        { ip: '1.1.1.1' },
        { ip: '2.2.2.2' },
        { ip: '3.3.3.3', org: 'Fastly, Inc.' },
      ],
    });

    const [change] = diffSnapshots(before, after, ALL);

    expect(change).toMatchObject({ watch: 'ip', severity: 'medium' });
    expect(change.text).toContain('New address: 3.3.3.3 (Fastly, Inc.)');
  });

  it('reports a removed address', () => {
    const after = snap({ addresses: [{ ip: '1.1.1.1' }] });

    const [change] = diffSnapshots(before, after, ALL);

    expect(change).toMatchObject({ watch: 'ip', severity: 'medium' });
    expect(change.text).toContain('Address no longer returned: 2.2.2.2');
  });

  it('treats a complete replacement as high severity — a move or a takeover', () => {
    const after = snap({ addresses: [{ ip: '9.9.9.9' }, { ip: '8.8.8.8' }] });

    expect(diffSnapshots(before, after, ALL)[0].severity).toBe('high');
  });

  it('says so when the domain no longer resolves at all', () => {
    const gone = snap({ addresses: [], dnsStatus: 'no_records' });
    const [change] = diffSnapshots(before, gone, ALL);
    expect(change).toMatchObject({ severity: 'high' });
    expect(change.text).toContain('no longer resolves');

    const missing = snap({ addresses: [], dnsStatus: 'nxdomain' });
    expect(diffSnapshots(before, missing, ALL)[0].text).toContain('NXDOMAIN');
  });

  it('is not fooled by the order of the addresses', () => {
    const reordered = snap({
      addresses: [{ ip: '2.2.2.2' }, { ip: '1.1.1.1' }],
    });
    expect(diffSnapshots(before, reordered, ALL)).toEqual([]);
  });

  it('abbreviates a long list', () => {
    const many = snap({
      addresses: Array.from({ length: 6 }, (_, i) => ({
        ip: `5.5.5.${i + 1}`,
      })),
    });
    const [change] = diffSnapshots(before, many, ALL);
    expect(change.text).toContain('and 3 more');
  });
});

describe('diffSnapshots — DNS records', () => {
  const base = { addresses: [{ ip: '1.1.1.1' }], advanced: [MX, NS, SOA(1)] };

  it('ranks nameserver changes highest', () => {
    const [change] = diffSnapshots(
      snap(base),
      snap({
        ...base,
        advanced: [MX, { ...NS, value: 'ns9.evil.example' }, SOA(1)],
      }),
      ALL,
    );

    expect(change).toMatchObject({ watch: 'dns', severity: 'high' });
    expect(change.text).toContain('Nameservers changed');
    expect(change.text).toContain('added ns9.evil.example');
    expect(change.text).toContain('removed ns1.example.net');
  });

  it('does not list the same record twice when a resolver repeats it', () => {
    const [change] = diffSnapshots(
      snap({ ...base, advanced: [MX, SOA(1), NS, NS] }),
      snap({
        ...base,
        advanced: [
          MX,
          SOA(1),
          { ...NS, value: 'ns2.example.net' },
          { ...NS, value: 'ns2.example.net' },
        ],
      }),
      ALL,
    );

    expect(change.text).toBe(
      'Nameservers changed: added ns2.example.net; removed ns1.example.net.',
    );
  });

  it('reports a changed mail server with its priority', () => {
    const [change] = diffSnapshots(
      snap(base),
      snap({ ...base, advanced: [{ ...MX, priority: 20 }, NS, SOA(1)] }),
      ALL,
    );

    expect(change).toMatchObject({ watch: 'dns', severity: 'medium' });
    expect(change.text).toContain('added 20 mail.example.com');
    expect(change.text).toContain('removed 10 mail.example.com');
  });

  it('reports a new TXT record at low severity and clips a long value', () => {
    const long = `v=spf1 ${'include:mail.example.com '.repeat(8)}~all`;
    const [change] = diffSnapshots(
      snap(base),
      snap({
        ...base,
        advanced: [
          MX,
          NS,
          SOA(1),
          { type: 'TXT', name: 'example.com', value: long },
        ],
      }),
      ALL,
    );

    expect(change).toMatchObject({ watch: 'dns', severity: 'low' });
    expect(change.text).toContain('…');
    expect(change.text.length).toBeLessThan(long.length);
  });

  it('reports an SOA serial bump as info, once', () => {
    const changes = diffSnapshots(
      snap(base),
      snap({ ...base, advanced: [MX, NS, SOA(2)] }),
      ALL,
    );

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ watch: 'dns', severity: 'info' });
    expect(changes[0].text).toContain('SOA serial changed from 1 to 2');
  });

  it('reports a CNAME change', () => {
    const [change] = diffSnapshots(
      snap({
        ...base,
        cnames: [{ name: 'www.example.com', value: 'a.example.net' }],
      }),
      snap({
        ...base,
        cnames: [{ name: 'www.example.com', value: 'b.example.net' }],
      }),
      ALL,
    );

    expect(change).toMatchObject({ watch: 'dns', severity: 'medium' });
    expect(change.text).toContain('CNAME changed');
  });

  it('reports reverse-DNS changes for an IP target', () => {
    const [change] = diffSnapshots(
      snap({ type: 'ipv4', reverse: ['old.example.net'] }),
      snap({ type: 'ipv4', reverse: ['new.example.net'] }),
      ALL,
    );

    expect(change).toMatchObject({ watch: 'dns', severity: 'low' });
    expect(change.text).toContain('Reverse DNS');
  });
});

describe('diffSnapshots — network owner', () => {
  const before = snap({
    addresses: [{ ip: '1.1.1.1', asn: 15169, org: 'Google LLC' }],
  });

  it('reports a move to another network at medium', () => {
    const after = snap({
      addresses: [{ ip: '1.1.1.1', asn: 13335, org: 'Cloudflare, Inc.' }],
    });

    const [change] = diffSnapshots(before, after, ['provider']);

    expect(change).toMatchObject({ watch: 'provider', severity: 'medium' });
    expect(change.text).toContain(
      'AS15169 (Google LLC) → AS13335 (Cloudflare, Inc.)',
    );
  });

  it('reports only a renamed organization as info', () => {
    const after = snap({
      addresses: [{ ip: '1.1.1.1', asn: 15169, org: 'Google Cloud' }],
    });

    expect(diffSnapshots(before, after, ['provider'])[0]).toMatchObject({
      watch: 'provider',
      severity: 'info',
    });
  });

  it('leaves an address that only one side knows to the IP check', () => {
    const after = snap({
      addresses: [{ ip: '4.4.4.4', asn: 1, org: 'Somebody else' }],
    });

    expect(diffSnapshots(before, after, ['provider'])).toEqual([]);
  });
});

describe('diffSnapshots — security', () => {
  const clean = snap({
    addresses: [{ ip: '1.1.1.1', security: { score: 10, level: 'low' } }],
  });
  const withSecurity = (security: FixtureOptions['addresses']) =>
    snap({ addresses: security });

  it('ignores a small drift in the score', () => {
    const after = withSecurity([
      { ip: '1.1.1.1', security: { score: 20, level: 'low' } },
    ]);
    expect(diffSnapshots(clean, after, ['security'])).toEqual([]);
  });

  it('reports a score jump, at the severity of the band it landed in', () => {
    const [change] = diffSnapshots(
      clean,
      withSecurity([{ ip: '1.1.1.1', security: { score: 64, level: 'high' } }]),
      ['security'],
    );

    expect(change).toMatchObject({ watch: 'security', severity: 'high' });
    expect(change.text).toContain('rose from 10 to 64 (high risk)');
  });

  it('reports crossing into a new band even for a small step', () => {
    const before = withSecurity([
      { ip: '1.1.1.1', security: { score: 24, level: 'low' } },
    ]);
    const after = withSecurity([
      { ip: '1.1.1.1', security: { score: 26, level: 'medium' } },
    ]);
    expect(diffSnapshots(before, after, ['security'])).toHaveLength(1);
  });

  it('treats an improvement as info', () => {
    const before = withSecurity([
      { ip: '1.1.1.1', security: { score: 80, level: 'high' } },
    ]);
    const [change] = diffSnapshots(before, clean, ['security']);
    expect(change).toMatchObject({ severity: 'info' });
    expect(change.text).toContain('fell from 80 to 10');
  });

  it('reports a Tor exit as high and a VPN warning as low', () => {
    const [tor] = diffSnapshots(
      clean,
      withSecurity([
        {
          ip: '1.1.1.1',
          security: { score: 10, level: 'low', tor: 'detected' },
        },
      ]),
      ['security'],
    );
    expect(tor).toMatchObject({ severity: 'high' });
    expect(tor.text).toContain('Tor signal was detected');

    const [vpn] = diffSnapshots(
      clean,
      withSecurity([
        {
          ip: '1.1.1.1',
          security: { score: 10, level: 'low', vpn: 'warning' },
        },
      ]),
      ['security'],
    );
    expect(vpn).toMatchObject({ severity: 'low' });
  });

  it('reports the first blacklisting as high', () => {
    const [change] = diffSnapshots(
      clean,
      withSecurity([
        { ip: '1.1.1.1', security: { score: 10, level: 'low', listed: 3 } },
      ]),
      ['security'],
    );
    expect(change).toMatchObject({ watch: 'security', severity: 'high' });
    expect(change.text).toContain('added to 3 blacklists');
  });

  it('says nothing when the earlier or the later reading is missing', () => {
    const unknown = withSecurity([{ ip: '1.1.1.1', security: 'unavailable' }]);
    expect(diffSnapshots(clean, unknown, ['security'])).toEqual([]);
    expect(diffSnapshots(unknown, clean, ['security'])).toEqual([]);
  });
});

describe('diffSnapshots — what the monitor watches', () => {
  const before = snap({
    addresses: [{ ip: '1.1.1.1' }],
    advanced: [NS],
  });
  const after = snap({
    addresses: [{ ip: '2.2.2.2' }],
    advanced: [{ ...NS, value: 'ns2.example.net' }],
  });

  it.each<[MonitorWatch[], MonitorWatch[]]>([
    [['dns'], ['dns']],
    [['ip'], ['ip']],
    [
      ['dns', 'ip'],
      ['ip', 'dns'],
    ],
    [['security'], []],
  ])('watching %j only reports %j', (watch, reported) => {
    const kinds = diffSnapshots(before, after, watch).map((c) => c.watch);
    expect([...new Set(kinds)].sort()).toEqual([...reported].sort());
  });
});

describe('draftAlerts', () => {
  const change = (
    watch: MonitorWatch,
    severity: Change['severity'],
    text: string,
  ): Change => ({ watch, severity, text });

  it('makes one alert per kind of change, with the type and category the site expects', () => {
    const drafts = draftAlerts([
      change('ip', 'medium', 'New address: 1.1.1.1.'),
      change('dns', 'high', 'Nameservers changed.'),
      change('security', 'low', 'VPN warning.'),
      change('provider', 'info', 'Organization renamed.'),
    ]);

    expect(drafts.map((d) => [d.watch, d.type, d.category])).toEqual([
      ['security', 'security_changed', 'security'],
      ['dns', 'dns_changed', 'dns'],
      ['ip', 'ip_changed', 'network'],
      ['provider', 'ip_changed', 'network'],
    ]);
  });

  it('takes the highest severity and joins the messages within a kind', () => {
    const [draft] = draftAlerts([
      change('dns', 'info', 'SOA serial changed.'),
      change('dns', 'high', 'Nameservers changed.'),
    ]);

    expect(draft.severity).toBe('high');
    expect(draft.message).toBe('SOA serial changed. Nameservers changed.');
    expect(draft.summary).toBe('SOA serial changed. (+1 more)');
  });

  it('returns nothing for no changes', () => {
    expect(draftAlerts([])).toEqual([]);
  });
});

describe('confirmedChanges', () => {
  const dns: Change = { watch: 'dns', severity: 'high', text: 'second dns' };
  const ip: Change = { watch: 'ip', severity: 'medium', text: 'second ip' };

  it('keeps only the kinds seen both times, worded from the later look', () => {
    const first: Change[] = [
      { watch: 'dns', severity: 'high', text: 'first dns' },
      { watch: 'security', severity: 'low', text: 'first security' },
    ];

    expect(confirmedChanges(first, [dns, ip])).toEqual([dns]);
  });

  it('confirms nothing when the second look shows no change', () => {
    expect(confirmedChanges([dns], [])).toEqual([]);
  });
});
