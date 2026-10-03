import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema';

export { schema };

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  pool: pg.Pool;
  close(): Promise<void>;
}

/** Opens a connection pool and the Drizzle client. Does not connect until the first query. */
export function createDatabase(databaseUrl: string): DatabaseHandle {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

/** The folder with the generated migrations: `apps/backend/drizzle`, whether run from src or dist. */
export function findMigrationsFolder(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(dir, 'drizzle');
    if (existsSync(join(candidate, 'meta', '_journal.json'))) return candidate;
    dir = dirname(dir);
  }
  throw new Error('Cannot find the drizzle migrations folder (apps/backend/drizzle).');
}

/** Applies pending migrations. Run at startup; safe to run repeatedly. */
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: findMigrationsFolder() });
}

/** True when the database answers a trivial query. */
export async function pingDatabase(pool: pg.Pool): Promise<boolean> {
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  }
}
