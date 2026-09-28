import type { User } from '../contracts';
import type { users } from '../db/schema';

export type UserRow = typeof users.$inferSelect;

/**
 * Database row -> the public `User` shape ipscope-web expects. Never includes `passwordHash`.
 * `effectivePlan` starts equal to `plan` — the honest answer for a row read outside of the few places that
 * enrich it with team membership (`AuthGuard`, `MonitorRunner`, `BulkRunner`; see `common/features.ts`).
 */
export const toUser = (row: UserRow): User => ({
  id: row.id,
  name: row.name,
  email: row.email,
  role: row.role,
  plan: row.plan,
  effectivePlan: row.plan,
  emailVerified: row.emailVerified,
  createdAt: row.createdAt.toISOString(),
});
