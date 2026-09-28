import { HttpException, type ArgumentsHost } from '@nestjs/common';
import { ApiException } from '../dto/api-exception';
import { ApiExceptionFilter } from './api-exception.filter';

const run = (
  exception: unknown,
  existingHeaders: Record<string, string> = {},
) => {
  const headers: Record<string, string> = {};
  const sent: { status?: number; body?: unknown } = {};
  const response = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    // What a guard that ran earlier already put on the response.
    getHeader: (name: string) => existingHeaders[name],
    status: (code: number) => {
      sent.status = code;
      return {
        json: (body: unknown) => {
          sent.body = body;
        },
      };
    },
  };
  new ApiExceptionFilter().catch(exception, {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost);
  return { headers, ...sent };
};

describe('ApiExceptionFilter', () => {
  it('answers with the { error: { code, message, details } } body', () => {
    const { status, body } = run(
      new ApiException('QUOTA_EXCEEDED', 'All used.', { limit: 100 }),
    );

    expect(status).toBe(429);
    expect(body).toEqual({
      error: {
        code: 'QUOTA_EXCEEDED',
        message: 'All used.',
        details: { limit: 100 },
      },
    });
  });

  it('adds Retry-After to a rate-limit refusal that says when to come back', () => {
    const { headers, status, body } = run(
      new ApiException('RATE_LIMITED', 'Slow down.', { retryAfterSeconds: 30 }),
    );

    expect(status).toBe(429);
    expect(headers['Retry-After']).toBe('30');
    expect(body).toMatchObject({
      error: { code: 'RATE_LIMITED', details: { retryAfterSeconds: 30 } },
    });
  });

  it('adds no Retry-After where there is nothing to wait for', () => {
    expect(run(new ApiException('RATE_LIMITED', 'Slow down.')).headers).toEqual(
      {},
    );
    expect(
      run(
        new ApiException('QUOTA_EXCEEDED', 'All used.', {
          retryAfterSeconds: 5,
        }),
      ).headers,
    ).toEqual({});
    expect(run(new ApiException('NOT_FOUND', 'Nope.')).headers).toEqual({});
  });

  describe('the per-IP throttle (a Nest 429 with Retry-After already set by the guard)', () => {
    it('puts the wait in the body too, and keeps the header the guard set', () => {
      const { status, body } = run(
        new HttpException('ThrottlerException: Too Many Requests', 429),
        {
          'Retry-After': '37',
        },
      );

      expect(status).toBe(429);
      expect(body).toEqual({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests. Try again in 37 seconds.',
          details: { retryAfterSeconds: 37 },
        },
      });
    });

    it('says "1 second", not "1 seconds"', () => {
      const { body } = run(new HttpException('x', 429), { 'Retry-After': '1' });

      expect((body as { error: { message: string } }).error.message).toBe(
        'Too many requests. Try again in 1 second.',
      );
    });

    it('falls back to the general message when no wait is known, or the header is junk', () => {
      for (const existing of [
        {},
        { 'Retry-After': 'soon' },
        { 'Retry-After': '0' },
      ]) {
        const { body } = run(new HttpException('x', 429), existing);

        expect(body).toEqual({
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many requests. Wait a few seconds and try again.',
          },
        });
      }
    });

    it('adds no wait to a non-429 error that happens to travel with the header', () => {
      const { body } = run(new HttpException('Nope', 404), {
        'Retry-After': '30',
      });

      expect(body).toEqual({ error: { code: 'NOT_FOUND', message: 'Nope' } });
    });
  });

  it('keeps hiding the details of an unexpected error', () => {
    const { status, body } = run(new Error('secret internals'));

    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('secret internals');
  });
});
