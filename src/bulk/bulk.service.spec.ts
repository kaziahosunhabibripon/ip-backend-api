import { ApiException } from '../common/dto/api-exception';
import type { AbuseService } from '../abuse/abuse.service';
import type { User } from '../contracts';
import { BulkService } from './bulk.service';
import type { BulkStore, StoredJob } from './bulk-store.service';

const user = (plan: User['plan'] = 'pro'): User => ({
  id: 'u1',
  name: 'U',
  email: 'u@example.test',
  role: 'user',
  plan,
  effectivePlan: plan,
  emailVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
});

const now = new Date('2026-09-27T10:00:00.000Z');
const stored = (over: Partial<StoredJob> = {}): StoredJob => ({
  id: 'job1',
  userId: 'u1',
  name: null,
  status: 'queued',
  duplicates: 0,
  stoppedReason: null,
  createdAt: now,
  startedAt: null,
  finishedAt: null,
  ...over,
});

const setup = (open = 0) => {
  const store = {
    countOpen: jest.fn(() => Promise.resolve(open)),
    createJob: jest.fn(
      (
        _userId: string,
        input: { name: string | null; duplicates: number; items: unknown[] },
      ) =>
        Promise.resolve(
          stored({ name: input.name, duplicates: input.duplicates }),
        ),
    ),
    countsByStatus: jest.fn(() =>
      Promise.resolve(new Map([['job1', { pending: 2 }]])),
    ),
    listJobs: jest.fn(() => Promise.resolve([stored()])),
    findJob: jest.fn(() => Promise.resolve(stored())),
    pageItems: jest.fn(() => Promise.resolve([])),
    deleteJob: jest.fn(() => Promise.resolve(true)),
  };
  const abuse = { note: jest.fn(() => Promise.resolve()) };
  const service = new BulkService(
    store as unknown as BulkStore,
    abuse as unknown as AbuseService,
  );
  return { service, store, abuse };
};

const rejection = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    return error as ApiException;
  }
  throw new Error('expected a rejection');
};

describe('BulkService.create', () => {
  it('queues the lines that are valid and reports the job', async () => {
    const { service, store } = setup();
    const created = await service.create(user(), {
      targets: ['example.com', ' 8.8.8.8 ', '', 'example.com'],
      name: '  Q3 review ',
    });

    const [, input] = store.createJob.mock.calls[0];
    expect(input.name).toBe('Q3 review');
    expect(input.duplicates).toBe(1);
    expect(input.items).toHaveLength(2);
    expect(created).toMatchObject({ id: 'job1', total: 2, duplicates: 1 });
  });

  it('refuses a batch bigger than the plan takes, saying how big it may be', async () => {
    const { service, store } = setup();
    const error = await rejection(
      service.create(user('pro'), {
        targets: Array.from({ length: 101 }, (_, i) => `h${i}.example.com`),
      }),
    );
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details).toMatchObject({ limit: 100, received: 101 });
    expect(store.createJob).not.toHaveBeenCalled();
  });

  it('takes a bigger batch on a bigger plan', async () => {
    const { service, store } = setup();
    await service.create(user('business'), {
      targets: Array.from({ length: 101 }, (_, i) => `h${i}.example.com`),
    });
    expect(store.createJob).toHaveBeenCalled();
  });

  it('refuses an empty batch, and one that is only blanks', async () => {
    const { service } = setup();
    for (const targets of [[], ['', '   ']]) {
      const error = await rejection(service.create(user(), { targets }));
      expect(error.code).toBe('INVALID_INPUT');
    }
  });

  it('allows two batches at once and refuses a third', async () => {
    const error = await rejection(
      setup(2).service.create(user(), { targets: ['example.com'] }),
    );
    expect(error.code).toBe('CONFLICT');
    await expect(
      setup(1).service.create(user(), { targets: ['example.com'] }),
    ).resolves.toBeDefined();
  });

  it('reports internal addresses to abuse detection, once per line', async () => {
    const { service, abuse } = setup();
    await service.create(user(), {
      targets: ['10.0.0.1', 'localhost', 'example.com', 'nonsense!!'],
    });
    expect(abuse.note).toHaveBeenCalledTimes(2);
    expect(abuse.note).toHaveBeenCalledWith(
      'account',
      'u1',
      'internal_targets',
    );
  });
});

describe('BulkService reads', () => {
  it('lists with the plan’s batch size, null for a negotiated one', async () => {
    const { service } = setup();
    await expect(service.list(user('pro'))).resolves.toMatchObject({
      batchSize: 100,
      openJobsLimit: 2,
    });
    await expect(service.list(user('enterprise'))).resolves.toMatchObject({
      batchSize: null,
    });
  });

  it('answers 404 for a batch that is not the caller’s, without saying whose it is', async () => {
    const { service, store } = setup();
    store.findJob.mockResolvedValueOnce(null as never);
    const error = await rejection(service.get(user(), 'other'));
    expect(error.code).toBe('NOT_FOUND');
    expect(store.findJob).toHaveBeenCalledWith('u1', 'other');
  });

  it('pages the lines from where it is asked', async () => {
    const { service, store } = setup();
    const page = await service.get(user(), 'job1', 200, 50);
    expect(store.pageItems).toHaveBeenCalledWith('job1', 200, 50);
    expect(page).toMatchObject({ offset: 200, limit: 50, items: [] });
  });

  it('deletes only the caller’s own batch', async () => {
    const { service, store } = setup();
    await service.remove(user(), 'job1');
    expect(store.deleteJob).toHaveBeenCalledWith('u1', 'job1');

    store.deleteJob.mockResolvedValueOnce(false);
    expect((await rejection(service.remove(user(), 'x'))).code).toBe(
      'NOT_FOUND',
    );
  });
});
