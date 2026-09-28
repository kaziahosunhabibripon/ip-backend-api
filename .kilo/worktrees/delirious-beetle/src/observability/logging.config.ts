import type { IncomingMessage, ServerResponse } from 'http';
import type { Params } from 'nestjs-pino';

/** Headers that carry credentials. Never written to a log line, whatever the log level. */
export const REDACTED_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-gateway-signature"]',
  'res.headers["set-cookie"]',
];

const QUIET_PATHS = new Set(['/api/v1/health', '/api/v1/health/ready']);

const pathOf = (url: string | undefined): string => {
  const raw = url ?? '';
  const cut = raw.indexOf('?');
  return cut === -1 ? raw : raw.slice(0, cut);
};

/**
 * The request as it appears in a log line: method and path only. The query string is dropped (it can hold an
 * email address or a token) and so is the socket address: visitors are only ever known by a keyed hash.
 */
export const serializeRequest = (req: {
  id?: unknown;
  method?: string;
  url?: string;
}) => ({
  id: req.id,
  method: req.method,
  url: pathOf(req.url),
});

export const serializeResponse = (res: { statusCode?: number }) => ({
  statusCode: res.statusCode,
});

export const levelForStatus = (
  status: number,
  error: Error | undefined,
): 'error' | 'warn' | 'info' => {
  if (error || status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return 'info';
};

export const buildLoggerParams = (options: {
  production: boolean;
  level?: string;
}): Params => ({
  pinoHttp: {
    level: options.level || (options.production ? 'info' : 'debug'),
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    serializers: { req: serializeRequest, res: serializeResponse },
    // Probes hit the health routes every few seconds; they would drown the real traffic.
    autoLogging: {
      ignore: (req: IncomingMessage) => QUIET_PATHS.has(pathOf(req.url)),
    },
    customLogLevel: (
      _req: IncomingMessage,
      res: ServerResponse,
      error: Error | undefined,
    ) => levelForStatus(res.statusCode, error),
    // Structured JSON in production (one object per line, for whatever collects the logs); readable lines otherwise.
    ...(options.production
      ? {}
      : {
          transport: {
            target: 'pino-pretty',
            options: { singleLine: true, colorize: true },
          },
        }),
  },
});
