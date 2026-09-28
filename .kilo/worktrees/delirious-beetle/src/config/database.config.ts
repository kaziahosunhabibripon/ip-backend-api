import { Client } from 'pg';
import { loadEnvironment } from './env.config';

loadEnvironment();

const isTruthy = (value: string | undefined) =>
  value === 'true' || value === '1' || value === 'yes';

const getRequiredEnvironmentValue = (
  key: string,
  options?: { allowEmpty?: boolean },
): string => {
  const rawValue = process.env[key];
  if (rawValue === undefined) {
    throw new Error(`${key} must be set`);
  }

  const value = rawValue.trim();
  if (!options?.allowEmpty && !value) {
    throw new Error(`${key} must be set`);
  }

  return value;
};

const getRequiredIntegerEnvironmentValue = (key: string): number => {
  const value = Number(getRequiredEnvironmentValue(key));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }

  return value;
};

const buildDatabaseUrl = () => {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) {
    return databaseUrl;
  }

  const host = getRequiredEnvironmentValue('DB_HOST');
  const port = getRequiredEnvironmentValue('DB_PORT');
  const name = getRequiredEnvironmentValue('DB_NAME');
  const user = getRequiredEnvironmentValue('DB_USER');
  const password = getRequiredEnvironmentValue('DB_PASSWORD', {
    allowEmpty: true,
  });

  const encodedUser = encodeURIComponent(user);
  const encodedPassword = encodeURIComponent(password);
  return `postgresql://${encodedUser}:${encodedPassword}@${host}:${port}/${name}`;
};

export const databaseConfig = {
  url: buildDatabaseUrl(),
  host: process.env.DB_HOST?.trim() ?? '',
  port: process.env.DB_PORT?.trim()
    ? getRequiredIntegerEnvironmentValue('DB_PORT')
    : 0,
  name: process.env.DB_NAME?.trim() ?? '',
  user: process.env.DB_USER?.trim() ?? '',
  ssl: isTruthy(process.env.DB_SSL) || false,
};

/**
 * node-postgres connection options handed to the Drizzle module, which owns the pool and closes it on shutdown.
 *
 * Timestamps are `timestamp without time zone` and Drizzle reads them as UTC, so `now()` defaults have to be
 * written as UTC too. Without pinning the session zone, a server or laptop that isn't on UTC stores its local
 * wall-clock time and every default-stamped column (created_at, alerts, …) reads back hours off.
 */
export const databaseConnection = {
  connectionString: databaseConfig.url,
  ssl: databaseConfig.ssl ? { rejectUnauthorized: false } : undefined,
  options: '-c timezone=UTC',
};

/** One-off connection used only by the startup gate in main.ts; the app's own queries go through the Drizzle pool. */
export const checkDatabaseConnection = async () => {
  const client = new Client(databaseConnection);
  await client.connect();
  try {
    await client.query('select 1');
  } finally {
    await client.end();
  }
};
