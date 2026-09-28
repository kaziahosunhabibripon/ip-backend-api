import { randomBytes } from 'node:crypto';
import { hashToken } from '../common/crypto';

export type ApiKeyEnvironment = 'production' | 'development';

const LABEL: Record<ApiKeyEnvironment, string> = {
  production: 'ips_live_',
  development: 'ips_test_',
};

/** `ips_live_` / `ips_test_` + 32 random bytes as base64url (43 characters). */
const SHAPE = /^ips_(?:live|test)_[A-Za-z0-9_-]{43}$/;

/** How much of a secret is kept in the clear to recognise a key by: the label and four characters. */
const DISPLAY_PREFIX_LENGTH = 13;

/** 256 bits of randomness behind a label that says which environment the key belongs to. */
export const generateApiKeySecret = (environment: ApiKeyEnvironment): string =>
  `${LABEL[environment]}${randomBytes(32).toString('base64url')}`;

/** The non-secret part shown in the key list, e.g. `ips_live_a1b2`. */
export const displayPrefixOf = (secret: string): string =>
  secret.slice(0, DISPLAY_PREFIX_LENGTH);

/**
 * Secrets are high-entropy random strings, so a plain SHA-256 is enough (no slow password hash needed) —
 * and being deterministic it can be looked up by an index on every request.
 */
export const hashApiKey = (secret: string): string => hashToken(secret);

/** False for anything that could not be one of our keys, so garbage never reaches the database. */
export const looksLikeApiKey = (value: string): boolean => SHAPE.test(value);

/** The token from an `Authorization: Bearer …` header; undefined when there is no header or another scheme. */
export const bearerTokenOf = (header: string | undefined): string | undefined =>
  /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')?.[1];
