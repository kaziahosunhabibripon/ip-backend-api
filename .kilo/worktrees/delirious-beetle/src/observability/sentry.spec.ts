import { initSentry, reportError, scrubEvent } from './sentry';

describe('scrubEvent', () => {
  it('removes credentials, cookies, bodies and the user from an event', () => {
    const event = scrubEvent({
      type: undefined,
      user: { id: 'u1', email: 'a@b.c' },
      request: {
        url: 'https://api.example/api/v1/check',
        cookies: { ipscope_session: 'abc' },
        data: { email: 'a@b.c', password: 'pw' },
        query_string: 'token=secret',
        headers: {
          Cookie: 'ipscope_session=abc',
          Authorization: 'Bearer KEY',
          'X-Gateway-Signature': 'SIG',
          Accept: 'application/json',
        },
      },
    });
    expect(event.user).toBeUndefined();
    expect(event.request).toEqual({
      url: 'https://api.example/api/v1/check',
      headers: { Accept: 'application/json' },
    });
  });

  it('leaves an event without a request alone', () => {
    expect(scrubEvent({ type: undefined, message: 'x' })).toEqual({
      type: undefined,
      message: 'x',
    });
  });
});

describe('sentry switch', () => {
  it('stays off without a DSN, and reporting is then a harmless no-op', () => {
    expect(initSentry({ environment: 'test' })).toBe(false);
    expect(initSentry({ dsn: '   ', environment: 'test' })).toBe(false);
    expect(() => reportError(new Error('boom'))).not.toThrow();
  });
});
