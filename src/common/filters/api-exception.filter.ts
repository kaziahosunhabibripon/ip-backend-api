import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { reportError } from '../../observability/sentry';
import { ApiErrorCode, ApiException } from '../dto/api-exception';

/** Maps a Nest-thrown HttpException's status to the nearest ApiErrorCode when it isn't already an ApiException — e.g. the 404 Nest raises for an unmatched route. */
const HTTP_STATUS_TO_CODE: Record<number, ApiErrorCode> = {
  401: 'AUTH_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'INVALID_INPUT',
  429: 'RATE_LIMITED',
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof ApiException) {
      if (exception.status >= 500) reportError(exception);
      const retryAfter = exception.details?.retryAfterSeconds;
      if (exception.code === 'RATE_LIMITED' && typeof retryAfter === 'number') {
        response.setHeader('Retry-After', String(retryAfter));
      }
      response.status(exception.status).json({
        error: {
          code: exception.code,
          message: exception.message,
          ...(exception.details ? { details: exception.details } : {}),
        },
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status >= 500) reportError(exception);
      const code = HTTP_STATUS_TO_CODE[status] ?? 'INTERNAL';

      // The per-IP throttle (@nestjs/throttler) has already put the seconds until its window reopens in
      // `Retry-After`. Say it in the body too: a browser on another origin can only read that header if CORS
      // exposes it, and clients that log or forward the body should not have to know to look there.
      const wait = Number(response.getHeader('Retry-After'));
      if (code === 'RATE_LIMITED' && Number.isFinite(wait) && wait > 0) {
        response.status(status).json({
          error: {
            code,
            message: `Too many requests. Try again in ${wait} second${wait === 1 ? '' : 's'}.`,
            details: { retryAfterSeconds: wait },
          },
        });
        return;
      }

      const message =
        code === 'RATE_LIMITED'
          ? 'Too many requests. Wait a few seconds and try again.'
          : exception.message || 'Request failed';
      response.status(status).json({ error: { code, message } });
      return;
    }

    this.logger.error(
      exception instanceof Error ? exception.stack : String(exception),
    );
    reportError(exception);
    response.status(500).json({
      error: { code: 'INTERNAL', message: 'Something broke on our side' },
    });
  }
}
