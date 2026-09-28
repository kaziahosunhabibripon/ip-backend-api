import { normalizeTarget } from './target-normalizer';

const ok = (input: string) => {
  const result = normalizeTarget(input);
  if (!result.ok) {
    throw new Error(`expected "${input}" to be valid, got ${result.reason}`);
  }
  return result;
};

const reasonOf = (input: string) => {
  const result = normalizeTarget(input);
  return result.ok ? 'ok' : result.reason;
};

describe('normalizeTarget — accepted forms', () => {
  it.each([
    ['google.com', 'domain', 'google.com'],
    ['  Google.COM  ', 'domain', 'google.com'],
    ['www.google.com', 'domain', 'www.google.com'],
    ['https://google.com', 'domain', 'google.com'],
    ['http://google.com/path/to?x=1#frag', 'domain', 'google.com'],
    ['https://user:pass@example.com:8443/a', 'domain', 'example.com'],
    ['example.com.', 'domain', 'example.com'],
    ['münchen.de', 'domain', 'xn--mnchen-3ya.de'],
    ['8.8.8.8', 'ipv4', '8.8.8.8'],
    ['http://8.8.8.8:8080/x', 'ipv4', '8.8.8.8'],
    ['2606:4700:4700::1111', 'ipv6', '2606:4700:4700::1111'],
    ['[2606:4700:4700::1111]:443', 'ipv6', '2606:4700:4700::1111'],
    ['https://[2606:4700:4700::1111]/', 'ipv6', '2606:4700:4700::1111'],
  ])('%s -> %s %s', (input, type, value) => {
    expect(ok(input)).toEqual({ ok: true, type, value });
  });
});

describe('normalizeTarget — rejected', () => {
  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['a'.repeat(2049), 'too_long'],
    ['ftp://example.com', 'unsupported_scheme'],
    ['file:///etc/passwd', 'unsupported_scheme'],
    ['exa mple.com', 'invalid_domain'],
    ['nodots', 'invalid_domain'],
    ['*.example.com', 'invalid_domain'],
    ['-bad-.com', 'invalid_domain'],
    ['example.c', 'invalid_domain'],
    ['example.com:99999', 'invalid_domain'],
    ['[::1', 'invalid_domain'],
    ['999.1.1.1', 'invalid_ip'],
    ['01.2.3.4', 'invalid_ip'],
    ['1:2:3', 'invalid_ip'],
    ['localhost', 'reserved_domain'],
    ['printer.local', 'reserved_domain'],
    ['db.internal', 'reserved_domain'],
    ['nas.home.arpa', 'reserved_domain'],
  ])('%s -> %s', (input, reason) => {
    expect(reasonOf(input)).toBe(reason);
  });

  it('refuses private, loopback, link-local and metadata addresses (SSRF guard)', () => {
    for (const address of [
      '10.0.0.1',
      '127.0.0.1',
      '172.16.5.5',
      '192.168.0.10',
      '169.254.169.254',
      'http://169.254.169.254/latest/meta-data',
      '100.64.1.1',
      '0.0.0.0',
      '::1',
      'fc00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '[::1]:8080',
    ]) {
      expect(reasonOf(address)).toBe('private_ip');
    }
  });

  it('explains what went wrong in words the UI can show', () => {
    const result = normalizeTarget('ftp://example.com');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.title).toMatch(/only web addresses/i);
      expect(result.message).toMatch(/ftp:\/\//);
    }
  });
});
