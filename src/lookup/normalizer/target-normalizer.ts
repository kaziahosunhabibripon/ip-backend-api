import type { InputType } from '../../contracts';
import {
  isNonPublicIPv4,
  isNonPublicIPv6,
  parseIPv4,
  parseIPv6,
} from './ip-address';

/**
 * Server-side twin of `normalizeTarget` in ipscope-web (`lib/validations/target.ts`, LLD §9). The
 * frontend copy only gives instant feedback; this one is the source of truth, and it doubles as
 * the SSRF guard — private and reserved ranges never reach a resolver or a provider.
 */

export type InvalidReason =
  | 'empty'
  | 'too_long'
  | 'unsupported_scheme'
  | 'invalid_domain'
  | 'invalid_ip'
  | 'private_ip'
  | 'reserved_domain';

export type NormalizeResult =
  | { ok: true; type: InputType; value: string }
  | { ok: false; reason: InvalidReason; title: string; message: string };

const MAX_INPUT_LENGTH = 2048;
const RESERVED_HOSTNAMES = new Set(['localhost', 'localdomain']);
const RESERVED_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.lan',
  '.home.arpa',
  '.intranet',
];

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

const fail = (
  reason: InvalidReason,
  title: string,
  message: string,
): NormalizeResult => ({ ok: false, reason, title, message });

const invalidDomain = (detail?: string): NormalizeResult =>
  fail(
    'invalid_domain',
    "That doesn't look like a valid domain or IP address.",
    detail ??
      'Check for typos. Domains look like example.com and IP addresses look like 1.1.1.1 or 2606:4700::1111.',
  );

const privateIp = (): NormalizeResult =>
  fail(
    'private_ip',
    "Private and reserved addresses can't be analyzed.",
    "Ranges like 10.x.x.x, 192.168.x.x and 127.0.0.1 aren't routable on the public internet, so there's no intelligence to show.",
  );

/** The URL parser applies IDNA/punycode and lowercases for us. */
const toAsciiHostname = (host: string): string | null => {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
};

export function normalizeTarget(input: string): NormalizeResult {
  let text = input.trim();

  if (!text) {
    return fail(
      'empty',
      'Enter a domain or IP address',
      'Type a domain like example.com or an IP like 1.1.1.1.',
    );
  }
  if (text.length > MAX_INPUT_LENGTH) {
    return fail(
      'too_long',
      'That input is too long.',
      'Domains and IP addresses are far shorter than this.',
    );
  }
  if (/\s/.test(text)) {
    return invalidDomain("Domains and IP addresses can't contain spaces.");
  }

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (name !== 'http' && name !== 'https') {
      return fail(
        'unsupported_scheme',
        'Only web addresses are supported.',
        `${name}:// links can't be analyzed. Paste a domain, an IP address or an http(s) URL.`,
      );
    }
    text = text.slice(scheme[0].length);
  }

  // Split authority from path / query / fragment.
  const boundary = text.search(/[/?#]/);
  let authority = boundary === -1 ? text : text.slice(0, boundary);

  if (authority.includes('@')) {
    authority = authority.slice(authority.lastIndexOf('@') + 1);
  }

  // Bracketed IPv6, host:port, or a bare host.
  let host = authority;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close === -1) {
      return invalidDomain();
    }
    host = authority.slice(1, close);
    const after = authority.slice(close + 1);
    if (after && !/^:\d{1,5}$/.test(after)) {
      return invalidDomain();
    }
  } else if (/^[^:]+:\d+$/.test(authority)) {
    const port = Number(authority.slice(authority.lastIndexOf(':') + 1));
    if (port < 1 || port > 65535) {
      return invalidDomain("That port number isn't valid.");
    }
    host = authority.slice(0, authority.lastIndexOf(':'));
  }

  if (!host) {
    return invalidDomain();
  }

  host = host.toLowerCase();
  if (host.endsWith('.') && !host.includes(':')) {
    host = host.replace(/\.+$/, '');
  }

  // ---- IPv6
  if (host.includes(':')) {
    const groups = parseIPv6(host);
    if (!groups) {
      return fail(
        'invalid_ip',
        "That IP address isn't valid.",
        'IPv6 addresses are eight groups of hex digits separated by colons, like 2606:4700:4700::1111.',
      );
    }
    if (isNonPublicIPv6(groups)) {
      return privateIp();
    }
    return { ok: true, type: 'ipv6', value: host };
  }

  // ---- IPv4 (or something that looks like an attempt at one)
  if (/^[\d.]+$/.test(host)) {
    const octets = parseIPv4(host);
    if (!octets) {
      return fail(
        'invalid_ip',
        "That IP address isn't valid.",
        'IPv4 addresses have four numbers between 0 and 255, like 8.8.8.8.',
      );
    }
    if (isNonPublicIPv4(octets)) {
      return privateIp();
    }
    return { ok: true, type: 'ipv4', value: host };
  }

  // ---- Domain
  if (host.includes('*')) {
    return invalidDomain(
      "Wildcards aren't supported. Enter a specific hostname.",
    );
  }
  if (
    RESERVED_HOSTNAMES.has(host) ||
    RESERVED_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    return fail(
      'reserved_domain',
      "Local hostnames can't be analyzed.",
      "Names like localhost or *.local only exist on your own network, so there's nothing public to look up.",
    );
  }

  const ascii = toAsciiHostname(host);
  if (!ascii || ascii.length > 253) {
    return invalidDomain();
  }
  const labels = ascii.split('.');
  if (labels.length < 2) {
    return invalidDomain(
      'Domains need a top-level domain, for example .com in example.com.',
    );
  }
  if (
    !labels.every((label) => DOMAIN_LABEL.test(label)) ||
    !TLD.test(labels[labels.length - 1])
  ) {
    return invalidDomain();
  }

  return { ok: true, type: 'domain', value: ascii };
}
