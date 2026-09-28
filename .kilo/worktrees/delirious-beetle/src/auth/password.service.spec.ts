import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes to a self-describing scrypt string and never contains the password', async () => {
    const hash = await service.hash('Sup3rSecret!pass');
    expect(hash.startsWith('scrypt$32768$8$3$')).toBe(true);
    expect(hash).not.toContain('Sup3rSecret');
  });

  it('accepts the right password and rejects a wrong one', async () => {
    const hash = await service.hash('Sup3rSecret!pass');
    await expect(service.verify('Sup3rSecret!pass', hash)).resolves.toBe(true);
    await expect(service.verify('Sup3rSecret!pasS', hash)).resolves.toBe(false);
  });

  it('salts every hash, so the same password never produces the same string', async () => {
    const [a, b] = await Promise.all([
      service.hash('Sup3rSecret!pass'),
      service.hash('Sup3rSecret!pass'),
    ]);
    expect(a).not.toBe(b);
  });

  it('rejects malformed stored values instead of throwing', async () => {
    await expect(service.verify('x', '')).resolves.toBe(false);
    await expect(service.verify('x', 'bcrypt$whatever')).resolves.toBe(false);
    await expect(service.verify('x', 'scrypt$1$2$3')).resolves.toBe(false);
  });

  it('can burn a dummy verification for unknown accounts', async () => {
    await expect(
      service.verifyAgainstDummy('anything'),
    ).resolves.toBeUndefined();
  });
});
