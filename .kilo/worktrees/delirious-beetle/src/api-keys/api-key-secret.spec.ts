import {
  bearerTokenOf,
  displayPrefixOf,
  generateApiKeySecret,
  hashApiKey,
  looksLikeApiKey,
} from './api-key-secret';

describe('generateApiKeySecret', () => {
  it('labels a production key live and a development key test, each followed by 43 random characters', () => {
    expect(generateApiKeySecret('production')).toMatch(
      /^ips_live_[A-Za-z0-9_-]{43}$/,
    );
    expect(generateApiKeySecret('development')).toMatch(
      /^ips_test_[A-Za-z0-9_-]{43}$/,
    );
  });

  it('never repeats', () => {
    const secrets = new Set(
      Array.from({ length: 200 }, () => generateApiKeySecret('production')),
    );
    expect(secrets.size).toBe(200);
  });
});

describe('displayPrefixOf', () => {
  it('keeps the label and four characters — enough to recognise a key, far too little to use it', () => {
    const secret = generateApiKeySecret('production');
    const prefix = displayPrefixOf(secret);

    expect(prefix).toHaveLength(13);
    expect(prefix.startsWith('ips_live_')).toBe(true);
    expect(secret.startsWith(prefix)).toBe(true);
  });
});

describe('hashApiKey', () => {
  it('is a stable SHA-256 hex digest that does not contain the secret', () => {
    const secret = generateApiKeySecret('production');

    expect(hashApiKey(secret)).toBe(hashApiKey(secret));
    expect(hashApiKey(secret)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(secret)).not.toContain(secret.slice(9));
  });

  it('differs for every key', () => {
    expect(hashApiKey(generateApiKeySecret('production'))).not.toBe(
      hashApiKey(generateApiKeySecret('production')),
    );
  });
});

describe('looksLikeApiKey', () => {
  it('accepts what generateApiKeySecret makes', () => {
    expect(looksLikeApiKey(generateApiKeySecret('production'))).toBe(true);
    expect(looksLikeApiKey(generateApiKeySecret('development'))).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['wrong label', `ips_prod_${'a'.repeat(43)}`],
    ['no label', 'a'.repeat(52)],
    ['too short', `ips_live_${'a'.repeat(42)}`],
    ['too long', `ips_live_${'a'.repeat(44)}`],
    ['illegal character', `ips_live_${'a'.repeat(42)}!`],
    ['whitespace inside', `ips_live_${'a'.repeat(21)} ${'a'.repeat(21)}`],
    ['a session-token-shaped string', 'a'.repeat(43)],
    ['a JWT', 'eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM'],
  ])('rejects %s, so it never reaches the database', (_label, value) => {
    expect(looksLikeApiKey(value)).toBe(false);
  });
});

describe('bearerTokenOf', () => {
  it('takes the token from a Bearer header, whatever the case of the scheme', () => {
    expect(bearerTokenOf('Bearer abc123')).toBe('abc123');
    expect(bearerTokenOf('bearer abc123')).toBe('abc123');
    expect(bearerTokenOf('BEARER   abc123  ')).toBe('abc123');
  });

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['another scheme', 'Basic dXNlcjpwYXNz'],
    ['a scheme with no token', 'Bearer'],
    ['a scheme with an empty token', 'Bearer '],
    ['two tokens', 'Bearer abc def'],
    ['the token alone', 'abc123'],
  ])('finds nothing in %s', (_label, header) => {
    expect(bearerTokenOf(header)).toBeUndefined();
  });
});
