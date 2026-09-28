import { checkResult } from './check-result.fixture-spec';
import { buildSnapshot } from './snapshot';

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

describe('buildSnapshot', () => {
  it('lists every address the resolver returned, sorted, not just the few that were analysed', () => {
    const addresses = ['9.9.9.9', '1.1.1.1', '8.8.8.8', '2606:4700::1'].map(
      (ip) => ({ ip }),
    );
    const snapshot = buildSnapshot(checkResult({ addresses }), null);

    expect(snapshot.addresses).toEqual([
      '1.1.1.1',
      '2606:4700::1',
      '8.8.8.8',
      '9.9.9.9',
    ]);
  });

  it('leaves TTLs out, so a resolver counting them down never looks like a change', () => {
    const first = buildSnapshot(
      checkResult({
        addresses: [{ ip: '1.1.1.1' }],
        advanced: [MX, NS],
        ttl: 300,
      }),
      null,
    );
    const later = buildSnapshot(
      checkResult({
        addresses: [{ ip: '1.1.1.1' }],
        advanced: [MX, NS],
        ttl: 41,
      }),
      null,
    );

    expect(later).toEqual(first);
  });

  it('keeps CNAME, MX and NS records and drops the ids', () => {
    const snapshot = buildSnapshot(
      checkResult({
        addresses: [{ ip: '1.1.1.1' }],
        cnames: [{ name: 'www.example.com', value: 'example.com' }],
        advanced: [NS, MX],
      }),
      null,
    );

    expect(snapshot.records).toEqual([
      { type: 'CNAME', name: 'www.example.com', value: 'example.com' },
      {
        type: 'MX',
        name: 'example.com',
        value: 'mail.example.com',
        priority: 10,
      },
      { type: 'NS', name: 'example.com', value: 'ns1.example.net' },
    ]);
  });

  it('records what it learned about each analysed address', () => {
    const snapshot = buildSnapshot(
      checkResult({
        addresses: [
          {
            ip: '1.1.1.1',
            asn: 13335,
            org: 'Cloudflare, Inc.',
            security: { score: 12, level: 'low', listed: 1, vpn: 'warning' },
          },
        ],
      }),
      null,
    );

    expect(snapshot.intel['1.1.1.1']).toEqual({
      network: { asn: 13335, organization: 'Cloudflare, Inc.' },
      security: {
        vpn: 'warning',
        proxy: 'clear',
        tor: 'clear',
        score: 12,
        level: 'low',
        listed: 1,
      },
    });
  });

  describe('when a provider could not answer this time', () => {
    const before = buildSnapshot(
      checkResult({
        addresses: [
          { ip: '1.1.1.1', security: { score: 40, level: 'medium' } },
        ],
        advanced: [MX, NS],
        cnames: [{ name: 'www.example.com', value: 'old.example.com' }],
      }),
      null,
    );

    it('carries the MX/NS/TXT/SOA records over instead of reading them as removed', () => {
      const after = buildSnapshot(
        checkResult({
          addresses: [{ ip: '1.1.1.1' }],
          advanced: 'failed',
          cnames: [{ name: 'www.example.com', value: 'new.example.com' }],
        }),
        before,
      );

      expect(after.records.filter((r) => r.type === 'MX')).toEqual([
        {
          type: 'MX',
          name: 'example.com',
          value: 'mail.example.com',
          priority: 10,
        },
      ]);
      expect(after.records.filter((r) => r.type === 'NS')).toHaveLength(1);
      // The CNAME comes from the main lookup, which did succeed, so it is taken fresh.
      expect(after.records.find((r) => r.type === 'CNAME')?.value).toBe(
        'new.example.com',
      );
    });

    it('carries the reputation over when the security provider is unavailable', () => {
      const after = buildSnapshot(
        checkResult({
          addresses: [{ ip: '1.1.1.1', security: 'unavailable' }],
          advanced: [MX, NS],
        }),
        before,
      );

      expect(after.intel['1.1.1.1'].security).toEqual(
        before.intel['1.1.1.1'].security,
      );
    });

    it('carries the network owner over when the ASN lookup is unavailable', () => {
      const after = buildSnapshot(
        checkResult({
          addresses: [{ ip: '1.1.1.1', network: 'unavailable' }],
          advanced: [MX, NS],
        }),
        before,
      );

      expect(after.intel['1.1.1.1'].network).toEqual(
        before.intel['1.1.1.1'].network,
      );
    });

    it('records nothing for a first look that is missing a provider', () => {
      const first = buildSnapshot(
        checkResult({
          addresses: [{ ip: '1.1.1.1', security: 'unavailable' }],
        }),
        null,
      );
      expect(first.intel['1.1.1.1'].security).toBeNull();
    });
  });

  describe('for an IP address', () => {
    it('records its reverse DNS names, sorted, and no addresses', () => {
      const snapshot = buildSnapshot(
        checkResult({
          type: 'ipv4',
          reverse: ['b.example.net', 'a.example.net'],
        }),
        null,
      );

      expect(snapshot.reverse).toEqual(['a.example.net', 'b.example.net']);
      expect(snapshot.addresses).toEqual([]);
      expect(snapshot.dnsStatus).toBeNull();
    });

    it('keeps the earlier reverse names when the PTR lookup failed', () => {
      const before = buildSnapshot(
        checkResult({ type: 'ipv4', reverse: ['host.example.net'] }),
        null,
      );
      const after = buildSnapshot(
        checkResult({ type: 'ipv4', reverse: 'failed' }),
        before,
      );
      expect(after.reverse).toEqual(['host.example.net']);
    });
  });
});
