import { EXPOSED_RESPONSE_HEADERS, buildCorsOptions } from './cors.config';

const decide = (allowed: string[], origin: string | undefined) => {
  const options = buildCorsOptions(allowed);
  let answer: boolean | undefined;
  (
    options.origin as (
      o: string | undefined,
      cb: (e: Error | null, ok?: boolean) => void,
    ) => void
  )(origin, (_error, ok) => {
    answer = ok;
  });
  return answer;
};

describe('buildCorsOptions', () => {
  it('lets a browser read the headers that say how long to wait and how much is left', () => {
    const { exposedHeaders } = buildCorsOptions([]);

    expect(exposedHeaders).toEqual(EXPOSED_RESPONSE_HEADERS);
    expect(exposedHeaders).toEqual(
      expect.arrayContaining([
        'Retry-After',
        'X-RateLimit-Limit',
        'X-RateLimit-Remaining',
        'X-RateLimit-Reset',
      ]),
    );
  });

  it('allows cookies, which is why the origin must be echoed rather than a wildcard', () => {
    expect(buildCorsOptions(['https://app.example.com']).credentials).toBe(
      true,
    );
  });

  it('still allows the methods and request headers the web app uses', () => {
    const options = buildCorsOptions([]);

    expect(options.methods).toEqual(
      expect.arrayContaining(['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']),
    );
    expect(options.allowedHeaders).toEqual(
      expect.arrayContaining(['Content-Type', 'Authorization']),
    );
  });

  it('accepts an origin on the list and refuses one that is not', () => {
    const list = ['https://app.example.com', 'http://localhost:3000'];

    expect(decide(list, 'https://app.example.com')).toBe(true);
    expect(decide(list, 'http://localhost:3000')).toBe(true);
    expect(decide(list, 'https://evil.example.com')).toBe(false);
    expect(decide(list, 'https://app.example.com.evil.com')).toBe(false);
  });

  it('accepts a request with no Origin (curl, server to server)', () => {
    expect(decide(['https://app.example.com'], undefined)).toBe(true);
  });

  it('accepts any origin only when the list says "*"', () => {
    expect(decide(['*'], 'https://anything.example.com')).toBe(true);
    expect(decide([], 'https://anything.example.com')).toBe(false);
  });
});
