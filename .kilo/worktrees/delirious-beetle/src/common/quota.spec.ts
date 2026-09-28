import type { User } from '../contracts';
import { buildQuotaSnapshot } from './quota';

const user = (plan: User['plan']): User => ({
  id: 'u1',
  name: 'Jane',
  email: 'jane@company.com',
  role: 'user',
  plan,
  effectivePlan: plan,
  emailVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
});

describe('buildQuotaSnapshot', () => {
  const now = new Date('2026-09-24T14:30:00.000Z');

  it('gives signed-out visitors a small daily quota that resets at the next UTC midnight', () => {
    expect(buildQuotaSnapshot(null, 0, now)).toEqual({
      scope: 'anonymous',
      used: 0,
      limit: 2,
      period: 'day',
      resetsAt: '2026-09-25T00:00:00.000Z',
    });
  });

  it('gives accounts a monthly quota by plan that resets on the 1st', () => {
    const free = buildQuotaSnapshot(user('free'), 0, now);
    expect(free).toMatchObject({
      scope: 'account',
      limit: 100,
      period: 'month',
    });
    expect(free.resetsAt).toBe('2026-10-01T00:00:00.000Z');
    expect(buildQuotaSnapshot(user('pro'), 0, now).limit).toBe(500);
    expect(buildQuotaSnapshot(user('business'), 0, now).limit).toBe(5000);
  });

  it('rolls the month over correctly in December', () => {
    const december = new Date('2026-12-15T10:00:00.000Z');
    expect(buildQuotaSnapshot(user('free'), 0, december).resetsAt).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('passes the used count through', () => {
    expect(buildQuotaSnapshot(user('free'), 42, now).used).toBe(42);
  });

  it('shows the limit a team riding member actually gets, not what their own plan alone would give', () => {
    const rider = user('free');
    rider.effectivePlan = 'business';
    expect(buildQuotaSnapshot(rider, 0, now).limit).toBe(5000);
  });
});
