import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, runMigrations, type DatabaseHandle } from '../../src/db';
import { cycleRuns } from '../../src/db/schema';
import { DATABASE_URL_TEST, resetDatabase } from './helpers';

describe('database', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = createDatabase(DATABASE_URL_TEST);
    await resetDatabase(handle);
  });

  afterAll(async () => {
    await handle.close();
  });

  it('applies the migrations to an empty database and is safe to run again', async () => {
    await runMigrations(handle.db);
    await runMigrations(handle.db);
    const { rows } = await handle.pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'activity_log',
      'agent_events',
      'chat_messages',
      'cycle_runs',
      'invites',
      'sessions',
      'tx_refs',
    ]);
  });

  it('rejects a second cycle run for the same treasury and cycle', async () => {
    await handle.db
      .insert(cycleRuns)
      .values({ orgTreasury: 'treasury::1', cycleId: '2026-09', status: 'running' });
    await expect(
      handle.db
        .insert(cycleRuns)
        .values({ orgTreasury: 'treasury::1', cycleId: '2026-09', status: 'running' }),
    ).rejects.toMatchObject({
      cause: { code: '23505', constraint: 'cycle_runs_org_cycle_unique' },
    });
    // Another cycle, or another treasury, is fine.
    await handle.db
      .insert(cycleRuns)
      .values({ orgTreasury: 'treasury::1', cycleId: '2026-10', status: 'running' });
    await handle.db
      .insert(cycleRuns)
      .values({ orgTreasury: 'treasury::2', cycleId: '2026-09', status: 'held' });
    const rows = await handle.db.select().from(cycleRuns);
    expect(rows).toHaveLength(3);
  });
});
