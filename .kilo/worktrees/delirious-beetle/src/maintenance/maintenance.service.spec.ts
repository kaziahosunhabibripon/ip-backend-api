import type { ConfigService } from '@nestjs/config';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Database } from '../db/database';
import { BATCH_SIZE, MaintenanceService } from './maintenance.service';

const dialect = new PgDialect();

const build = (rowCounts: number[]) => {
  const statements: { sql: string; params: unknown[] }[] = [];
  const queue = [...rowCounts];
  const db = {
    execute: jest.fn((query: Parameters<PgDialect['sqlToQuery']>[0]) => {
      const { sql, params } = dialect.sqlToQuery(query);
      statements.push({ sql, params });
      return Promise.resolve({ rowCount: queue.shift() ?? 0 });
    }),
  };
  const config = { get: () => undefined } as unknown as ConfigService;
  return {
    service: new MaintenanceService(db as unknown as Database, config),
    statements,
    db,
  };
};

describe('MaintenanceService.prune', () => {
  const now = new Date('2026-09-26T12:00:00.000Z');

  it('runs one delete per kind and reports what each removed', async () => {
    const { service } = build([3, 2, 100, 7, 1, 4, 5]);
    await expect(service.prune(now)).resolves.toEqual({
      sessions: 3,
      authTokens: 2,
      lookupEvents: 100,
      anonymousCounters: 7,
      monthlyCounters: 1,
      alerts: 4,
      bulkJobs: 5,
    });
  });

  it('touches only the bookkeeping tables', async () => {
    const { service, statements } = build([]);
    await service.prune(now);
    const tables = statements.map(
      (s) => /delete from "(\w+)"/.exec(s.sql)?.[1],
    );
    expect(tables).toEqual([
      'sessions',
      'auth_tokens',
      'lookup_events',
      'usage_counters',
      'usage_counters',
      'alerts',
      'bulk_jobs',
    ]);
    for (const protectedTable of [
      'history_items',
      'monitors',
      'api_keys',
      'subscriptions',
      'payments',
      'audit_log',
      'users',
    ]) {
      expect(tables).not.toContain(protectedTable);
    }
  });

  it('passes the cutoff as a bound ISO timestamp, not spliced into the text', async () => {
    const { service, statements } = build([]);
    await service.prune(now);
    expect(statements[0].params).toContain('2026-09-25T12:00:00.000Z');
    expect(statements[0].sql).not.toContain('2026-09-25');
  });

  it('keeps anonymous and per-account counters apart', async () => {
    const { service, statements } = build([]);
    await service.prune(now);
    expect(statements[3].sql).toContain(`key like 'anon:%'`);
    expect(statements[4].sql).toContain(`key not like 'anon:%'`);
  });

  it('repeats a kind in batches until a batch comes back short', async () => {
    const { service, statements } = build([
      BATCH_SIZE,
      BATCH_SIZE,
      12, // sessions: 2 full batches, then a short one
    ]);
    const report = await service.prune(now);
    expect(report.sessions).toBe(BATCH_SIZE * 2 + 12);
    expect(statements.filter((s) => s.sql.includes('"sessions"'))).toHaveLength(
      3,
    );
  });

  it('lets a database error surface to the caller', async () => {
    const { service, db } = build([]);
    db.execute.mockRejectedValueOnce(new Error('down'));
    await expect(service.prune(now)).rejects.toThrow('down');
  });
});
