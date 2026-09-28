import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import type { Express, NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { Logger as PinoLogger } from 'nestjs-pino';
import type { ValidationError } from 'class-validator';
import { AppModule } from './app.module';
import { ApiException } from './common/dto/api-exception';
import { buildCorsOptions } from './config/cors.config';
import { checkDatabaseConnection } from './config/database.config';
import { isProductionEnvironment } from './config/env.config';
import { initSentry } from './observability/sentry';

// Colour codes are for a person reading a terminal; in production the log line is JSON for a collector.
const colorize = (code: number, text: string) =>
  isProductionEnvironment() ? text : `\x1b[${code}m${text}\x1b[0m`;
const API_PREFIX = 'api/v1';
const DOCS_PATH = 'docs';
const DEFAULT_DEV_CORS_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

const getRequiredIntegerConfigValue = (
  configService: ConfigService,
  key: string,
): number => {
  const value = Number(configService.getOrThrow<string>(key));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }

  return value;
};

const readAllowedCorsOrigins = (
  configService: ConfigService,
  isProduction: boolean,
): string[] => {
  const configuredOrigins = (
    configService.get<string>('CORS_ALLOWED_ORIGINS') ?? ''
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (configuredOrigins.length > 0) {
    return configuredOrigins;
  }

  return isProduction ? [] : DEFAULT_DEV_CORS_ORIGINS;
};

const flattenValidationErrors = (
  errors: ValidationError[],
  details: Record<string, string> = {},
): Record<string, string> => {
  for (const error of errors) {
    const [firstConstraint] = Object.values(error.constraints ?? {});
    if (firstConstraint) {
      details[error.property] = firstConstraint;
    }
    if (error.children?.length) {
      flattenValidationErrors(error.children, details);
    }
  }

  return details;
};

async function bootstrap() {
  const sentryOn = initSentry({
    dsn: process.env.SENTRY_DSN,
    environment:
      process.env.SENTRY_ENVIRONMENT ||
      (isProductionEnvironment() ? 'production' : 'development'),
    release: process.env.SENTRY_RELEASE,
  });

  try {
    await checkDatabaseConnection();
    Logger.log(colorize(36, 'Database connection successful'), 'Bootstrap');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Logger.error(
      colorize(31, `Database connection failed: ${message}`),
      undefined,
      'Bootstrap',
    );
    process.exit(1);
  }

  // The payment gateway signs the exact bytes it sends, so its webhook route needs the body unparsed as well as parsed.
  // Buffered so the start-up lines above and below come out through pino once it is ready, not half in each format.
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    bufferLogs: true,
  });
  app.useLogger(app.get(PinoLogger));
  if (sentryOn) {
    Logger.log('Error reporting to Sentry is on', 'Bootstrap');
  }
  const isProduction = isProductionEnvironment();
  const configService = app.get(ConfigService);
  const configuredCorsOrigins = readAllowedCorsOrigins(
    configService,
    isProduction,
  );

  // Behind a reverse proxy the socket address is the proxy's, so per-visitor quotas and rate limits need
  // Express to read the client address from X-Forwarded-For: TRUST_PROXY=<number of proxy hops>.
  const trustProxy = configService.get<string>('TRUST_PROXY')?.trim();
  if (trustProxy) {
    const expressApp = app.getHttpAdapter().getInstance() as Express;
    expressApp.set(
      'trust proxy',
      /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy,
    );
  }

  // An API serves JSON and never renders a page, so the strictest content policy costs nothing. The Swagger UI
  // at /docs needs inline scripts and styles, so that path alone goes without a content policy.
  // The web app on another origin reads these responses through CORS; helmet's default same-origin
  // resource policy would block it, hence `cross-origin`.
  const apiHelmet = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
  const docsHelmet = helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
  if (isProduction) {
    // Both are silent failures that only show up as odd behaviour under real traffic, so say so at boot.
    if (!trustProxy) {
      Logger.warn(
        'TRUST_PROXY is not set. Behind a reverse proxy every visitor then shares the proxy address, and per-visitor quotas and rate limits act on everyone at once.',
        'Bootstrap',
      );
    }
    if (configuredCorsOrigins.length === 0) {
      Logger.warn(
        'CORS_ALLOWED_ORIGINS is empty, so no browser on another origin can call this API.',
        'Bootstrap',
      );
    }
    if (configService.get<string>('COOKIE_CROSS_SITE')?.trim() === 'true') {
      Logger.warn(
        'COOKIE_CROSS_SITE is on. The session cookie is set SameSite=None, which is weaker CSRF protection than the default SameSite=Lax — meant for cross-domain testing (e.g. a tunnel), not for production.',
        'Bootstrap',
      );
    }
  }

  app.use((req: Request, res: Response, next: NextFunction) =>
    (req.path === `/${DOCS_PATH}` ||
      req.path.startsWith(`/${DOCS_PATH}/`) ||
      req.path === `/${DOCS_PATH}-json`
      ? docsHelmet
      : apiHelmet)(req, res, next),
  );
  app.use(compression());
  app.use(cookieParser());
  app.enableShutdownHooks();
  app.setGlobalPrefix(API_PREFIX);

  app.enableCors(buildCorsOptions(configuredCorsOrigins));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // No implicit conversion: it would turn the JSON string "false" into `true` before IsBoolean runs.
      // Query params that need numbers use an explicit `@Type(() => Number)` on the DTO field.
      exceptionFactory: (errors: ValidationError[]) =>
        new ApiException(
          'INVALID_INPUT',
          'The request failed validation.',
          flattenValidationErrors(errors),
        ),
    }),
  );

  const swaggerDocument = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('IPScope API')
      .setDescription(
        [
          'IP and domain intelligence: geolocation, ASN and network, reputation and threat signals, DNS and WHOIS.',
          '',
          '**Authentication.** The web app signs in with a session cookie (`POST /auth/login`). Programmatic callers send an API key as `Authorization: Bearer <key>` — create one under *API keys* (Pro and above). Endpoints marked with a padlock need one or the other; the rest are public.',
          '',
          '**Errors.** Every error is `{ "error": { "code", "message", "details"? } }`. `code` is stable and safe to branch on; `message` is for people.',
          '',
          '**Limits.** Each plan has a monthly lookup quota (`QUOTA_EXCEEDED`, 429, reopens at `details.resetsAt`). Every API key also has a per-minute limit and every client IP a general throttle; both answer `RATE_LIMITED` (429) with `Retry-After` and `details.retryAfterSeconds`. API key responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`.',
        ].join('\n'),
      )
      .setVersion('1')
      .addCookieAuth('ipscope_session', {
        type: 'apiKey',
        in: 'cookie',
        description:
          'Set by POST /auth/login and /auth/register (HttpOnly, Secure, SameSite=Lax).',
      })
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'API key',
          description:
            'An API key created under *API keys* in the dashboard, sent as `Authorization: Bearer <key>`.',
        },
        'apiKey',
      )
      .build(),
  );
  SwaggerModule.setup(DOCS_PATH, app, swaggerDocument);

  const port = getRequiredIntegerConfigValue(configService, 'PORT');
  const host = configService.getOrThrow<string>('HOST');
  await app.listen(port, host);

  const url = await app.getUrl();
  Logger.log(colorize(35, `API running at ${url}/${API_PREFIX}`), 'Bootstrap');
  Logger.log(colorize(35, `API docs at ${url}/${DOCS_PATH}`), 'Bootstrap');
}

void bootstrap();
