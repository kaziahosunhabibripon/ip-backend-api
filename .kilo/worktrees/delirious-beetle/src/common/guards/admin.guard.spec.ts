import type { ExecutionContext } from '@nestjs/common';
import type { ApiException } from '../dto/api-exception';
import type { Role } from '../../contracts';
import { AdminGuard } from './admin.guard';

const contextFor = (user?: { role: Role }) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as unknown as ExecutionContext;

const errorOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error as ApiException;
  }
  throw new Error('expected an exception');
};

describe('AdminGuard', () => {
  const guard = new AdminGuard();

  it('lets an administrator through', () => {
    expect(guard.canActivate(contextFor({ role: 'admin' }))).toBe(true);
  });

  it('refuses a regular user with FORBIDDEN', () => {
    const error = errorOf(() =>
      guard.canActivate(contextFor({ role: 'user' })),
    );

    expect(error.code).toBe('FORBIDDEN');
    expect(error.status).toBe(403);
  });

  it('asks a signed-out caller to sign in first', () => {
    const error = errorOf(() => guard.canActivate(contextFor(undefined)));

    expect(error.code).toBe('AUTH_REQUIRED');
    expect(error.status).toBe(401);
  });
});
