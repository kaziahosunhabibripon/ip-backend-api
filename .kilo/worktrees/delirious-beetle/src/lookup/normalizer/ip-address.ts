export type Ipv4Octets = readonly [number, number, number, number];
export type IpVersion = 4 | 6;

const HEX_GROUP = /^[0-9a-f]{1,4}$/i;

export function parseIPv4(value: string): Ipv4Octets | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!match) {
    return null;
  }

  const octets = match.slice(1).map((part) => {
    // Leading zeros are ambiguous (octal in some parsers), so reject them outright.
    if (part.length > 1 && part.startsWith('0')) {
      return Number.NaN;
    }
    return Number(part);
  });
  if (octets.some((n) => Number.isNaN(n) || n > 255)) {
    return null;
  }

  return octets as unknown as Ipv4Octets;
}

/** Addresses that only exist on private networks or aren't routable — never worth looking up. */
export function isNonPublicIPv4([a, b, c]: readonly number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast + reserved + broadcast
  );
}

/** The eight 16-bit groups of an IPv6 literal, or null when malformed. */
export function parseIPv6(input: string): number[] | null {
  if (
    input.includes('%') ||
    !/^[0-9a-f:.]+$/i.test(input) ||
    !input.includes(':')
  ) {
    return null;
  }

  let text = input;
  let embeddedV4: number[] | null = null;
  if (text.includes('.')) {
    const split = text.lastIndexOf(':');
    const v4 = parseIPv4(text.slice(split + 1));
    if (!v4) {
      return null;
    }
    embeddedV4 = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    text = `${text.slice(0, split + 1)}0:0`;
  }

  const parts = text.split('::');
  if (parts.length > 2) {
    return null;
  }
  const compressed = parts.length === 2;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = compressed && parts[1] ? parts[1].split(':') : [];
  const groups = [...head, ...tail];
  if (groups.some((group) => !HEX_GROUP.test(group))) {
    return null;
  }
  if (compressed ? groups.length > 7 : groups.length !== 8) {
    return null;
  }

  const full = compressed
    ? [...head, ...Array<string>(8 - groups.length).fill('0'), ...tail]
    : groups;
  const numbers = full.map((group) => parseInt(group, 16));
  if (embeddedV4) {
    numbers[6] = embeddedV4[0];
    numbers[7] = embeddedV4[1];
  }

  return numbers;
}

export function isNonPublicIPv6(groups: readonly number[]): boolean {
  const allZeroButLast = groups.slice(0, 7).every((group) => group === 0);
  if (allZeroButLast && (groups[7] === 0 || groups[7] === 1)) {
    return true; // :: and ::1
  }
  if ((groups[0] & 0xfe00) === 0xfc00) {
    return true; // fc00::/7 unique local
  }
  if ((groups[0] & 0xffc0) === 0xfe80) {
    return true; // fe80::/10 link local
  }
  if ((groups[0] & 0xff00) === 0xff00) {
    return true; // multicast
  }
  const mapped =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (mapped) {
    return isNonPublicIPv4([
      groups[6] >> 8,
      groups[6] & 255,
      groups[7] >> 8,
      groups[7] & 255,
    ]);
  }

  return false;
}

/** Compressed lowercase form, e.g. `2606:4700:4700::1111`. */
export function formatIPv6(groups: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < 8; start += 1) {
    if (groups[start] !== 0) {
      continue;
    }
    let end = start;
    while (end < 8 && groups[end] === 0) {
      end += 1;
    }
    if (end - start > bestLength) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }

  const hex = groups.map((group) => group.toString(16));
  if (bestLength < 2) {
    return hex.join(':');
  }

  const head = hex.slice(0, bestStart).join(':');
  const tail = hex.slice(bestStart + bestLength).join(':');
  return `${head}::${tail}`;
}

export function ipVersionOf(ip: string): IpVersion | null {
  if (parseIPv4(ip)) {
    return 4;
  }
  return parseIPv6(ip) ? 6 : null;
}

/** True only for a syntactically valid, publicly routable address. */
export function isPublicIp(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4) {
    return !isNonPublicIPv4(v4);
  }
  const v6 = parseIPv6(ip);
  return v6 ? !isNonPublicIPv6(v6) : false;
}

/** The PTR query name for an address: `1.1.1.1` -> `1.1.1.1.in-addr.arpa`. */
export function reverseDnsName(ip: string): string | null {
  const v4 = parseIPv4(ip);
  if (v4) {
    return `${[...v4].reverse().join('.')}.in-addr.arpa`;
  }

  const v6 = parseIPv6(ip);
  if (!v6) {
    return null;
  }
  const nibbles = v6
    .map((group) => group.toString(16).padStart(4, '0'))
    .join('')
    .split('')
    .reverse();
  return `${nibbles.join('.')}.ip6.arpa`;
}

/** The CIDR block an address falls in, given the prefix length a database reports for it. */
export function networkOf(ip: string, prefixLength: number): string | null {
  const v4 = parseIPv4(ip);
  if (v4) {
    const bits = Math.min(Math.max(prefixLength, 0), 32);
    const value = ((v4[0] << 24) | (v4[1] << 16) | (v4[2] << 8) | v4[3]) >>> 0;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    const base = (value & mask) >>> 0;
    return `${base >>> 24}.${(base >>> 16) & 255}.${(base >>> 8) & 255}.${base & 255}/${bits}`;
  }

  const v6 = parseIPv6(ip);
  if (!v6) {
    return null;
  }
  const bits = Math.min(Math.max(prefixLength, 0), 128);
  const masked = v6.map((group, index) => {
    const keep = Math.min(Math.max(bits - index * 16, 0), 16);
    const mask = keep === 0 ? 0 : (0xffff << (16 - keep)) & 0xffff;
    return group & mask;
  });
  return `${formatIPv6(masked)}/${bits}`;
}
