/**
 * Seeds LocalNet with real demo history (T4, U8, details.md feature 17): the organization, the
 * sealed Mandate, units for four holders, test funds, auto-receive for Holders A to C (Holder D keeps
 * the pending-acceptance path) and two executed cycles, June (400 CC) and July (420 CC), all tagged
 * "seeded". The demo then runs August (clean) and September (flagged) live.
 * Every step prints one line and skips itself when it is already done, so it is safe to run again.
 *
 *   pnpm seed:localnet               seed the LocalNet in .env (the backend's own modules)
 *   pnpm seed:localnet --sandbox     seed the full-stack test server's world on the Canton sandbox
 *                                    (test adapters, where Holders A to C already have auto-receive;
 *                                    the world is kept in .sandbox-seed-world.json, so a second run
 *                                    finds everything done)
 */
import { resolve } from 'node:path';
import { ConfigError, loadConfig, loadDotEnv } from '../apps/backend/src/config/env';
import { createDatabase, runMigrations, type DatabaseHandle } from '../apps/backend/src/db';
import { createBackend, type Backend } from '../apps/backend/src/wiring/backend';
import { SeedError, runSeed } from './seed/steps';

const SANDBOX_STATE_FILE = resolve(import.meta.dirname, '../.sandbox-seed-world.json');

interface Seeding {
  backend: Backend;
  database: DatabaseHandle;
  close(): Promise<void>;
}

async function openSandbox(): Promise<Seeding> {
  // The test server lives under test/ and is only loaded here, never by application code.
  const { bootFullStack } = await import('../apps/backend/test/e2e/server');
  const stack = await bootFullStack({
    statePath: SANDBOX_STATE_FILE,
    initialFunds: '5000',
    holdCountdownSeconds: 1,
    webDistDir: null,
    logLevel: 'silent',
  });
  process.stdout.write(
    stack.reused
      ? `Using the sandbox world in ${SANDBOX_STATE_FILE}\n`
      : `Created a new sandbox world (kept in ${SANDBOX_STATE_FILE})\n`,
  );
  return { backend: stack.backend, database: stack.database, close: () => stack.close() };
}

async function openLocalnet(): Promise<Seeding> {
  loadDotEnv();
  const config = loadConfig(process.env);
  const database = createDatabase(config.databaseUrl);
  await runMigrations(database.db);
  // A one-second Hold countdown: demo history does not need to wait for people to press Hold.
  const backend = createBackend(config, database, { holdCountdownSeconds: 1 });
  return {
    backend,
    database,
    async close() {
      await backend.stop();
      await database.close();
    },
  };
}

async function main(): Promise<void> {
  const sandbox = process.argv.includes('--sandbox');
  let seeding: Seeding;
  try {
    seeding = sandbox ? await openSandbox() : await openLocalnet();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
  let failed = false;
  try {
    const results = await runSeed({
      backend: seeding.backend,
      print: (line) => process.stdout.write(`${line}\n`),
    });
    const changed = results.filter((r) => r.outcome === 'done').length;
    process.stdout.write(
      changed === 0
        ? 'Nothing to do: the demo history is already in place.\n'
        : `Done: ${changed} of ${results.length} steps changed something.\n`,
    );
  } catch (error) {
    failed = true;
    process.stderr.write(
      `${error instanceof SeedError ? error.message : error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
  } finally {
    await seeding.close();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
