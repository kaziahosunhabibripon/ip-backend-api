import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/**
 * Response headers a browser on another origin may read. By default CORS hides everything but a handful of
 * "safe" headers, so without this the web app could not see how long to wait after a 429 (`Retry-After`) or how
 * much of an API key's allowance is left (`X-RateLimit-*`), even though the server sends them.
 */
export const EXPOSED_RESPONSE_HEADERS = [
  'Retry-After',
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
];

/**
 * CORS for a browser front end on a different origin that signs in with a cookie (`credentials: true`), so
 * the origin is echoed back exactly and never `*`. `*` in the list means "any origin" — only for a deployment
 * that wants that; an origin the browser sends that isn't listed simply gets no CORS headers.
 */
export const buildCorsOptions = (allowedOrigins: string[]): CorsOptions => {
  const allowAll = allowedOrigins.includes('*');
  const allowed = new Set(allowedOrigins);

  return {
    origin: (origin, callback) => {
      // No Origin header: not a browser cross-origin call (curl, server to server, same-origin).
      if (!origin || allowAll || allowed.has(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: EXPOSED_RESPONSE_HEADERS,
  };
};
