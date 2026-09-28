import { ApiException } from '../common/dto/api-exception';
import type { CheckResponse, Plan } from '../contracts';
import type { LookupService } from '../lookup/lookup.service';
import type { TeamsService } from '../teams/teams.service';
import type { UsersService } from '../users/users.service';
import { BulkRunner } from './bulk-runner.service';
import type { BulkStore, PendingItem, StoredJob } from './bulk-store.service';

const job = { id: 'job1', userId: 'u1' } as StoredJob;
const FAR = Date.now() + 3_600_000;

const item = (
  position: number,
  target = `t${position}.example`,
): PendingItem => ({
  position,
  input: target,
  target,
  type: 'domain',
});

const answer = (status = 'completed'): CheckResponse =>
  ({ result: { status, ips: [] } }) as unknown as CheckResponse;

const setup = (
  options: {
    plan?: string;
    groups?: PendingItem[][];
    lookup?: jest.Mock;
    renew?: boolean;
    user?: boolean;
    /** What `TeamsService.effectivePlan` should answer — defaults to the account's own plan (no elevation). */
    teamPlan?: Plan;
  } = {},
) => {
  const groups = [...(options.groups ?? [[item(1)]]), []];
  const store = {
    pending: jest.fn(() => Promise.resolve(groups.shift() ?? [])),
    recordItem: jest.fn(() => Promise.resolve()),
    skipRemaining: jest.fn(() => Promise.resolve(0)),
    finish: jest.fn(() => Promise.resolve()),
    releaseLease: jest.fn(() => Promise.resolve()),
    renewLease: jest.fn(() => Promise.resolve(options.renew ?? true)),
  };
  const lookup = {
    check: options.lookup ?? jest.fn(() => Promise.resolve(answer())),
  };
  const users = {
    findById: jest.fn(() =>
      Promise.resolve(
        options.user === false
          ? undefined
          : {
              id: 'u1',
              name: 'U',
              email: 'u@example.test',
              role: 'user',
              plan: options.plan ?? 'pro',
              emailVerified: true,
              createdAt: new Date('2026-01-01T00:00:00Z'),
            },
      ),
    ),
  };
  const teams = {
    effectivePlan: jest.fn(() =>
      Promise.resolve(options.teamPlan ?? options.plan ?? 'pro'),
    ),
  };
  const runner = new BulkRunner(
    store as unknown as BulkStore,
    lookup as unknown as LookupService,
    users as unknown as UsersService,
    teams as unknown as TeamsService,
  );
  return { runner, store, lookup, teams };
};

describe('BulkRunner', () => {
  it('looks each line up as the account, without history, and records a summary', async () => {
    const { runner, store, lookup } = setup({
      groups: [[item(1, 'a.example'), item(2, 'b.example')]],
    });

    await expect(runner.run(job, FAR)).resolves.toBe('finished');

    expect(lookup.check).toHaveBeenCalledWith(
      'a.example',
      expect.objectContaining({
        user: expect.objectContaining({ id: 'u1', plan: 'pro' }),
        skipHistory: true,
      }),
      false,
    );
    expect(store.recordItem).toHaveBeenCalledWith(
      'job1',
      1,
      expect.objectContaining({ status: 'completed' }),
    );
    expect(store.recordItem).toHaveBeenCalledWith(
      'job1',
      2,
      expect.objectContaining({ status: 'completed' }),
    );
    expect(store.finish).toHaveBeenCalledWith('job1', null, expect.any(Date));
    expect(store.skipRemaining).not.toHaveBeenCalled();
  });

  it('records a lookup failure on its own line and carries on with the rest', async () => {
    const lookup = jest
      .fn()
      .mockRejectedValueOnce(
        new ApiException('DNS_TIMEOUT', 'The DNS lookup timed out.'),
      )
      .mockResolvedValueOnce(answer('partial'));
    const { runner, store } = setup({
      groups: [[item(1), item(2)]],
      lookup,
    });

    await runner.run(job, FAR);

    expect(store.recordItem).toHaveBeenCalledWith('job1', 1, {
      status: 'failed',
      error: { code: 'DNS_TIMEOUT', message: 'The DNS lookup timed out.' },
    });
    expect(store.recordItem).toHaveBeenCalledWith(
      'job1',
      2,
      expect.objectContaining({ status: 'partial' }),
    );
  });

  it('turns an unexpected error into a failed line without leaking its message', async () => {
    const lookup = jest
      .fn()
      .mockRejectedValue(new Error('connection string leaked'));
    const { runner, store } = setup({ lookup });

    await runner.run(job, FAR);

    const [, , outcome] = store.recordItem.mock.calls[0] as unknown as [
      string,
      number,
      { status: string; error: { code: string; message: string } },
    ];
    expect(outcome.status).toBe('failed');
    expect(outcome.error.code).toBe('INTERNAL');
    expect(outcome.error.message).not.toMatch(/leaked/);
  });

  it('stops when the month’s lookups run out, keeps what was done, and skips the rest', async () => {
    const lookup = jest
      .fn()
      .mockResolvedValueOnce(answer())
      .mockRejectedValueOnce(new ApiException('QUOTA_EXCEEDED', 'used up'))
      .mockRejectedValueOnce(new ApiException('QUOTA_EXCEEDED', 'used up'));
    const { runner, store } = setup({
      groups: [[item(1), item(2), item(3)], [item(4)]],
      lookup,
    });

    await expect(runner.run(job, FAR)).resolves.toBe('finished');

    expect(store.recordItem).toHaveBeenCalledTimes(1);
    expect(store.recordItem).toHaveBeenCalledWith('job1', 1, expect.anything());
    expect(store.skipRemaining).toHaveBeenCalledWith(
      'job1',
      expect.objectContaining({ code: 'QUOTA_EXCEEDED' }),
    );
    expect(store.finish).toHaveBeenCalledWith(
      'job1',
      'quota',
      expect.any(Date),
    );
    // It never went on to the next group.
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('does not look anything up once the plan no longer includes bulk lookup', async () => {
    const { runner, store, lookup } = setup({ plan: 'free' });

    await expect(runner.run(job, FAR)).resolves.toBe('finished');

    expect(lookup.check).not.toHaveBeenCalled();
    expect(store.skipRemaining).toHaveBeenCalledWith(
      'job1',
      expect.objectContaining({ code: 'PLAN_REQUIRED' }),
    );
    expect(store.finish).toHaveBeenCalledWith('job1', 'plan', expect.any(Date));
  });

  it('still runs a Free owner’s batch when a team elevates them to bulk lookup, checked fresh — not at creation time', async () => {
    const { runner, lookup, teams } = setup({
      plan: 'free',
      teamPlan: 'business',
      groups: [[item(1)]],
    });

    await expect(runner.run(job, FAR)).resolves.toBe('finished');

    expect(lookup.check).toHaveBeenCalledWith(
      't1.example',
      expect.objectContaining({
        user: expect.objectContaining({ effectivePlan: 'business' }),
      }),
      false,
    );
    expect(teams.effectivePlan).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1', plan: 'free' }),
    );
  });

  it('gives up quietly when the job was deleted mid-run', async () => {
    const { runner, store } = setup({
      groups: [[item(1)], [item(2)]],
      renew: false,
    });

    await expect(runner.run(job, FAR)).resolves.toBe('cancelled');
    expect(store.finish).not.toHaveBeenCalled();
  });

  it('gives up when the owner no longer exists', async () => {
    const { runner, lookup } = setup({ user: false });
    await expect(runner.run(job, FAR)).resolves.toBe('cancelled');
    expect(lookup.check).not.toHaveBeenCalled();
  });

  it('hands the job back when its time slice is over, leaving the rest pending', async () => {
    const { runner, store, lookup } = setup({ groups: [[item(1)]] });

    await expect(runner.run(job, Date.now() - 1)).resolves.toBe('paused');

    expect(lookup.check).not.toHaveBeenCalled();
    expect(store.releaseLease).toHaveBeenCalledWith('job1', expect.any(Date));
    expect(store.finish).not.toHaveBeenCalled();
  });

  it('hands the job back on shutdown', async () => {
    const { runner, store } = setup({ groups: [[item(1)]] });
    await expect(runner.run(job, FAR, () => true)).resolves.toBe('paused');
    expect(store.releaseLease).toHaveBeenCalled();
  });

  it('works through several groups before finishing', async () => {
    const { runner, store, lookup } = setup({
      groups: [[item(1), item(2)], [item(3)]],
    });
    await runner.run(job, FAR);
    expect(lookup.check).toHaveBeenCalledTimes(3);
    expect(store.renewLease).toHaveBeenCalledTimes(2);
    expect(store.finish).toHaveBeenCalledTimes(1);
  });
});
