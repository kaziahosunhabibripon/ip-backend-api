import { createHash, randomBytes } from 'node:crypto';

/** 256 random bits, URL-safe. Used for session cookies and emailed one-time links. */
export const generateToken = (): string =>
  randomBytes(32).toString('base64url');

/** Tokens are never stored raw — only this hash, so a database leak can't be replayed as a login. */
export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
