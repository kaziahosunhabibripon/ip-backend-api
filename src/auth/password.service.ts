import { Injectable } from '@nestjs/common';
import {
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

const KEY_LENGTH = 64;
// OWASP's scrypt parameters (N=2^15, r=8, p=3). maxmem must exceed the ~32 MiB the N/r pair needs.
const COST = { N: 2 ** 15, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

const deriveKey = (
  password: string,
  salt: Buffer,
  options: ScryptOptions,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });

/**
 * scrypt is built into Node, memory-hard, and needs no native build step (npm blocks
 * install scripts here, which rules out `bcrypt`). Stored as `scrypt$N$r$p$salt$hash`,
 * so the cost can be raised later and old hashes still verify.
 */
@Injectable()
export class PasswordService {
  private dummyHash?: Promise<string>;

  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await deriveKey(password, salt, COST);
    return [
      'scrypt',
      COST.N,
      COST.r,
      COST.p,
      salt.toString('base64'),
      key.toString('base64'),
    ].join('$');
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const [scheme, n, r, p, salt, hash] = stored.split('$');
    if (scheme !== 'scrypt' || !salt || !hash) {
      return false;
    }

    const expected = Buffer.from(hash, 'base64');
    const actual = await deriveKey(password, Buffer.from(salt, 'base64'), {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: COST.maxmem,
    });

    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }

  /** Spends the same CPU as a real check, so login timing doesn't reveal which emails are registered. */
  async verifyAgainstDummy(password: string): Promise<void> {
    this.dummyHash ??= this.hash(randomBytes(16).toString('hex'));
    await this.verify(password, await this.dummyHash);
  }
}
