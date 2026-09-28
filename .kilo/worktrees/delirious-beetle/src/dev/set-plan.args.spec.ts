import { USAGE, parseSetPlanArgs } from './set-plan.args';

describe('parseSetPlanArgs', () => {
  it.each(['free', 'pro', 'business', 'enterprise'])('accepts %s', (plan) => {
    expect(parseSetPlanArgs(['jane@company.com', plan])).toEqual({
      ok: true,
      email: 'jane@company.com',
      plan,
    });
  });

  it('trims and lowercases, like every address stored here', () => {
    expect(parseSetPlanArgs(['  Jane@Company.COM ', ' PRO '])).toEqual({
      ok: true,
      email: 'jane@company.com',
      plan: 'pro',
    });
  });

  it.each([
    [[]],
    [['jane@company.com']],
    [['jane@company.com', 'pro', 'extra']],
    [['', 'pro']],
    [['jane@company.com', '']],
  ])('prints the usage for %j', (argv) => {
    expect(parseSetPlanArgs(argv)).toEqual({ ok: false, message: USAGE });
  });

  it('names a plan that does not exist and lists the real ones', () => {
    const result = parseSetPlanArgs(['jane@company.com', 'gold']);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('"gold" is not a plan');
    expect(result.ok ? '' : result.message).toContain(
      'free, pro, business, enterprise',
    );
  });

  it('rejects something that is not an email', () => {
    const result = parseSetPlanArgs(['pro', 'jane@company.com']);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain(
      "doesn't look like an email",
    );
  });
});
