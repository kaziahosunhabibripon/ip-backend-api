import { Writable } from 'stream';
import { pino } from 'pino';
import {
  REDACTED_PATHS,
  buildLoggerParams,
  levelForStatus,
  serializeRequest,
} from './logging.config';

describe('serializeRequest', () => {
  it('keeps the method and path but drops the query string', () => {
    expect(
      serializeRequest({
        id: 'r1',
        method: 'GET',
        url: '/api/v1/auth/verify?token=secret&email=a@b.c',
      }),
    ).toEqual({ id: 'r1', method: 'GET', url: '/api/v1/auth/verify' });
  });

  it('does not carry the socket address or headers', () => {
    const line = serializeRequest({
      id: 'r1',
      method: 'GET',
      url: '/x',
      remoteAddress: '203.0.113.9',
      headers: { cookie: 'ipscope_session=abc' },
    } as never);
    expect(JSON.stringify(line)).not.toMatch(/203\.0\.113\.9|ipscope_session/);
  });
});

describe('levelForStatus', () => {
  it.each([
    [200, undefined, 'info'],
    [302, undefined, 'info'],
    [404, undefined, 'warn'],
    [429, undefined, 'warn'],
    [500, undefined, 'error'],
    [503, undefined, 'error'],
    [200, new Error('boom'), 'error'],
  ] as const)('status %i with error %p is %s', (status, error, level) => {
    expect(levelForStatus(status, error)).toBe(level);
  });
});

describe('buildLoggerParams', () => {
  const httpOptions = (production: boolean, level?: string) =>
    (buildLoggerParams({ production, level }) as { pinoHttp: any }).pinoHttp;

  it('logs JSON in production and pretty lines elsewhere', () => {
    expect(httpOptions(true).transport).toBeUndefined();
    expect(httpOptions(false).transport.target).toBe('pino-pretty');
  });

  it('defaults the level by environment and lets LOG_LEVEL override it', () => {
    expect(httpOptions(true).level).toBe('info');
    expect(httpOptions(false).level).toBe('debug');
    expect(httpOptions(true, 'warn').level).toBe('warn');
  });

  it('keeps health probes out of the log', () => {
    const { ignore } = httpOptions(true).autoLogging;
    expect(ignore({ url: '/api/v1/health' })).toBe(true);
    expect(ignore({ url: '/api/v1/health/ready?x=1' })).toBe(true);
    expect(ignore({ url: '/api/v1/check' })).toBe(false);
  });

  it('redacts credential headers when a line is actually written', () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        chunks.push(chunk.toString());
        done();
      },
    });
    const log = pino(
      { redact: { paths: REDACTED_PATHS, censor: '[redacted]' } },
      sink,
    );
    log.info({
      req: {
        headers: {
          cookie: 'ipscope_session=SESSION',
          authorization: 'Bearer KEY',
          'x-gateway-signature': 'SIG',
          accept: 'json',
        },
      },
      res: { headers: { 'set-cookie': 'ipscope_session=NEW' } },
    });
    const line = chunks.join('');
    expect(line).not.toMatch(/SESSION|KEY|SIG"|NEW/);
    expect(line).toContain('"accept":"json"');
  });
});
