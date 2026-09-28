import * as Sentry from '@sentry/node';

let enabled = false;

/** Strips what must never leave the server: credentials in headers, cookies and request bodies. */
export const scrubEvent = <T extends Sentry.ErrorEvent>(event: T): T => {
  const request = event.request;
  if (request) {
    delete request.cookies;
    delete request.data;
    delete request.query_string;
    if (request.headers) {
      for (const name of Object.keys(request.headers)) {
        if (/^(cookie|authorization|x-gateway-signature)$/i.test(name)) {
          delete request.headers[name];
        }
      }
    }
  }
  delete event.user;
  return event;
};

/** Ships dark: nothing is sent unless `SENTRY_DSN` is set. Returns whether reporting is on. */
export const initSentry = (options: {
  dsn?: string;
  environment: string;
  release?: string;
}): boolean => {
  const dsn = options.dsn?.trim();
  if (!dsn) return false;
  Sentry.init({
    dsn,
    environment: options.environment,
    release: options.release,
    // Nothing about the visitor leaves the server: an error report needs the stack, not who hit it. `scrubEvent`
    // below is the backstop should an integration attach any of it anyway.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    tracesSampleRate: 0,
    beforeSend: scrubEvent,
  });
  enabled = true;
  return true;
};

/** Reports an unexpected failure. A no-op when Sentry is off, and never throws: reporting must not break a response. */
export const reportError = (error: unknown): void => {
  if (!enabled) return;
  try {
    Sentry.captureException(error);
  } catch {
    // Nothing useful to do; the error is already logged.
  }
};
