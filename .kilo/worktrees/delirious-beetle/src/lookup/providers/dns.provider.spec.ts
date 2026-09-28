import { DnsProvider } from './dns.provider';
import { ProviderUnavailableError } from './provider.types';

type Answer = { name: string; type: number; TTL: number; data: string };
type Reply = { Status: number; Answer?: Answer[] };

const A = 1;
const NS = 2;
const CNAME = 5;
const SOA = 6;
const PTR = 12;
const MX = 15;
const TXT = 16;
const AAAA = 28;

/** Routes fake DoH requests by `name` + `type`; anything unlisted is NOERROR with no data. */
const mockDoh = (
  table: Record<string, Reply>,
  options: { firstResolverDown?: boolean; allDown?: boolean } = {},
) =>
  jest.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = urlOf(input);
    if (options.allDown) {
      return Promise.reject(new Error('network down'));
    }
    if (options.firstResolverDown && url.hostname === 'cloudflare-dns.com') {
      return Promise.resolve(new Response('bad gateway', { status: 502 }));
    }
    const key = `${url.searchParams.get('name')}|${url.searchParams.get('type')}`;
    const reply = table[key] ?? { Status: 0 };
    return Promise.resolve(Response.json(reply));
  });

const signal = () => new AbortController().signal;

const urlOf = (input: RequestInfo | URL) =>
  new URL(
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );

afterEach(() => jest.restoreAllMocks());

describe('DnsProvider.resolveAddresses', () => {
  const chain: Answer[] = [
    { name: 'www.github.com', type: CNAME, TTL: 3600, data: 'github.com.' },
  ];

  it('collects the CNAME chain and both address families, once each', async () => {
    mockDoh({
      'www.github.com|1': {
        Status: 0,
        Answer: [
          ...chain,
          { name: 'github.com', type: A, TTL: 38, data: '20.205.243.166' },
        ],
      },
      'www.github.com|28': {
        Status: 0,
        Answer: [
          ...chain,
          {
            name: 'github.com',
            type: AAAA,
            TTL: 60,
            data: '2606:50C0:8000::154',
          },
        ],
      },
    });

    const result = await new DnsProvider().resolveAddresses(
      'www.github.com',
      signal(),
    );

    expect(result.status).toBe('resolved');
    expect(result.resolver).toBe('1.1.1.1');
    expect(result.records.map((record) => record.type)).toEqual([
      'CNAME',
      'A',
      'AAAA',
    ]);
    expect(result.records[0]).toMatchObject({
      name: 'www.github.com',
      value: 'github.com',
      ttl: 3600,
    });
    expect(result.addresses).toEqual([
      { ip: '20.205.243.166', version: 4, source: 'A' },
      { ip: '2606:50c0:8000::154', version: 6, source: 'AAAA' },
    ]);
    expect(new Set(result.records.map((record) => record.id)).size).toBe(3);
  });

  it('reports NXDOMAIN, SERVFAIL and empty answers as distinct statuses', async () => {
    mockDoh({
      'gone.example|1': { Status: 3 },
      'gone.example|28': { Status: 3 },
      'broken.example|1': { Status: 2 },
      'broken.example|28': { Status: 2 },
    });
    const dns = new DnsProvider();

    await expect(
      dns.resolveAddresses('gone.example', signal()),
    ).resolves.toMatchObject({
      status: 'nxdomain',
      addresses: [],
    });
    await expect(
      dns.resolveAddresses('broken.example', signal()),
    ).resolves.toMatchObject({
      status: 'servfail',
    });
    await expect(
      dns.resolveAddresses('empty.example', signal()),
    ).resolves.toMatchObject({
      status: 'no_records',
    });
  });

  it('falls back to the second resolver when the first is down', async () => {
    mockDoh(
      {
        'a.example|1': {
          Status: 0,
          Answer: [{ name: 'a.example', type: A, TTL: 30, data: '1.2.3.4' }],
        },
      },
      { firstResolverDown: true },
    );

    const result = await new DnsProvider().resolveAddresses(
      'a.example',
      signal(),
    );
    expect(result.resolver).toBe('8.8.8.8');
    expect(result.addresses).toHaveLength(1);
  });

  it('throws ProviderUnavailableError when no resolver answers', async () => {
    mockDoh({}, { allDown: true });
    await expect(
      new DnsProvider().resolveAddresses('a.example', signal()),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('stops immediately once the deadline has passed instead of trying more resolvers', async () => {
    const controller = new AbortController();
    const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
      controller.abort();
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });

    await expect(
      new DnsProvider().resolveAddresses('a.example', controller.signal),
    ).rejects.toThrow();
    // one attempt per record type — never a second resolver after the abort
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('DnsProvider.resolveAdvanced', () => {
  it('parses MX, NS, TXT and SOA at the registrable domain', async () => {
    mockDoh({
      'github.com|15': {
        Status: 0,
        Answer: [
          {
            name: 'github.com.',
            type: MX,
            TTL: 273,
            data: '20 alt.mail.example.',
          },
          {
            name: 'github.com.',
            type: MX,
            TTL: 273,
            data: '10 github-com.mail.protection.outlook.com.',
          },
        ],
      },
      'github.com|2': {
        Status: 0,
        Answer: [
          {
            name: 'github.com.',
            type: NS,
            TTL: 900,
            data: 'NS-1707.awsdns-21.co.uk.',
          },
        ],
      },
      'github.com|16': {
        Status: 0,
        Answer: [
          {
            name: 'github.com.',
            type: TXT,
            TTL: 300,
            data: '"v=spf1 include:a.example " "~all"',
          },
        ],
      },
      'github.com|6': {
        Status: 0,
        Answer: [
          {
            name: 'github.com.',
            type: SOA,
            TTL: 900,
            data: 'ns-1707.awsdns-21.co.uk. awsdns-hostmaster.amazon.com. 1 7200 900 1209600 86400',
          },
        ],
      },
    });

    // A subdomain is asked about its registrable parent.
    const records = await new DnsProvider().resolveAdvanced(
      'gist.github.com',
      signal(),
    );

    expect(
      records
        .filter((record) => record.type === 'MX')
        .map((record) => [record.priority, record.value]),
    ).toEqual([
      [10, 'github-com.mail.protection.outlook.com'],
      [20, 'alt.mail.example'],
    ]);
    expect(records.find((record) => record.type === 'NS')?.value).toBe(
      'ns-1707.awsdns-21.co.uk',
    );
    expect(records.find((record) => record.type === 'TXT')?.value).toBe(
      'v=spf1 include:a.example ~all',
    );
    expect(records.find((record) => record.type === 'SOA')?.value).toBe(
      'ns-1707.awsdns-21.co.uk awsdns-hostmaster.amazon.com 1 7200 900 1209600 86400',
    );
    expect(records.every((record) => record.name === 'github.com')).toBe(true);
  });
});

describe('DnsProvider.reverse', () => {
  it('returns PTR names without the trailing dot, and nothing when there are none', async () => {
    mockDoh({
      '1.1.1.1.in-addr.arpa|12': {
        Status: 0,
        Answer: [
          {
            name: '1.1.1.1.in-addr.arpa',
            type: PTR,
            TTL: 1199,
            data: 'one.one.one.one.',
          },
        ],
      },
    });
    const dns = new DnsProvider();

    await expect(dns.reverse('1.1.1.1', signal())).resolves.toEqual([
      'one.one.one.one',
    ]);
    await expect(dns.reverse('8.8.4.4', signal())).resolves.toEqual([]);
    await expect(dns.reverse('not-an-ip', signal())).resolves.toEqual([]);
  });
});
