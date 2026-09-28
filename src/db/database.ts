import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema';

/** Type of the injected Drizzle database: `@InjectDrizzle() private readonly db: Database`. */
export type Database = NodePgDatabase<typeof schema>;
