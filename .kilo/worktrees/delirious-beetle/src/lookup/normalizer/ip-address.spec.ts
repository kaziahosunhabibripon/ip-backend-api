import {
  formatIPv6,
  ipVersionOf,
  isPublicIp,
  networkOf,
  parseIPv4,
  parseIPv6,
  reverseDnsName,
} from './ip-address';

describe('parseIPv4', () => {
  it('parses dotted quads and rejects everything else', () => {
    expect(parseIPv4('8.8.8.8')).toEqual([8, 8, 8, 8]);
    expect(parseIPv4('256.1.1.1')).toBeNull();
    expect(parseIPv4('1.2.3')).toBeNull();
    expect(parseIPv4('01.2.3.4')).toBeNull(); // leading zero = octal ambiguity
    expect(parseIPv4('1.2.3.4.5')).toBeNull();
  });
});

describe('parseIPv6 / formatIPv6', () => {
  it('expands and re-compresses addresses', () => {
    expect(parseIPv6('2606:4700:4700::1111')).toEqual([
      0x2606, 0x4700, 0x4700, 0, 0, 0, 0, 0x1111,
    ]);
    expect(formatIPv6(parseIPv6('2606:4700:4700:0:0:0:0:1111')!)).toBe(
      '2606:4700:4700::1111',
    );
    expect(formatIPv6(parseIPv6('::1')!)).toBe('::1');
    expect(formatIPv6(parseIPv6('2001:db8:0:1:1:1:1:1')!)).toBe(
      '2001:db8:0:1:1:1:1:1',
    );
  });

  it('handles embedded IPv4 and rejects malformed input', () => {
    expect(parseIPv6('::ffff:1.2.3.4')).toEqual([
      0, 0, 0, 0, 0, 0xffff, 0x102, 0x304,
    ]);
    expect(parseIPv6('1::2::3')).toBeNull();
    expect(parseIPv6('fe80::1%eth0')).toBeNull();
    expect(parseIPv6('12345::')).toBeNull();
  });
});

describe('isPublicIp', () => {
  it.each([
    ['8.8.8.8', true],
    ['1.1.1.1', true],
    ['2606:4700:4700::1111', true],
    ['10.1.2.3', false],
    ['127.0.0.1', false],
    ['192.168.1.1', false],
    ['172.16.0.1', false],
    ['169.254.169.254', false], // cloud metadata endpoint
    ['100.64.0.1', false],
    ['224.0.0.1', false],
    ['::1', false],
    ['fc00::1', false],
    ['fe80::1', false],
    ['::ffff:10.0.0.1', false],
    ['not-an-ip', false],
  ])('%s -> %s', (ip, expected) => {
    expect(isPublicIp(ip)).toBe(expected);
  });
});

describe('ipVersionOf', () => {
  it('tells the versions apart', () => {
    expect(ipVersionOf('1.1.1.1')).toBe(4);
    expect(ipVersionOf('2606:4700::1111')).toBe(6);
    expect(ipVersionOf('example.com')).toBeNull();
  });
});

describe('reverseDnsName', () => {
  it('builds the PTR query name for both versions', () => {
    expect(reverseDnsName('1.2.3.4')).toBe('4.3.2.1.in-addr.arpa');
    expect(reverseDnsName('2001:db8::1')).toBe(
      '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa',
    );
    expect(reverseDnsName('nope')).toBeNull();
  });
});

describe('networkOf', () => {
  it('masks an address down to the CIDR block a database reports', () => {
    expect(networkOf('8.8.8.8', 24)).toBe('8.8.8.0/24');
    expect(networkOf('142.250.190.14', 15)).toBe('142.250.0.0/15');
    expect(networkOf('1.2.3.4', 32)).toBe('1.2.3.4/32');
    expect(networkOf('1.2.3.4', 0)).toBe('0.0.0.0/0');
    expect(networkOf('200.201.202.203', 8)).toBe('200.0.0.0/8');
    expect(networkOf('2606:4700:4700::1111', 48)).toBe('2606:4700:4700::/48');
    expect(networkOf('2001:4860:4860::8888', 42)).toBe('2001:4860:4840::/42');
    expect(networkOf('garbage', 24)).toBeNull();
  });
});
