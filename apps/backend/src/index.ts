import { ConfigError, loadConfig, loadDotEnv, type Config } from './config/env';
import { createDatabase, runMigrations } from './db';
import { createBackend } from './wiring/backend';

async function main(): Promise<void> {
  loadDotEnv();
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const database = createDatabase(config.databaseUrl);
  try {
    await runMigrations(database.db);
  } catch (error) {
    process.stderr.write(
      `Cannot prepare the database from DATABASE_URL. Check that PostgreSQL is running and the URL is right.\n${error instanceof Error ? error.message : String(error)}\n`,
    );
    await database.close().catch(() => undefined);
    process.exit(1);
  }

  // Ledger, asset adapter, event bus, party names, activity log, cycle module with the AI memo
  // writer, funding, agent, drafters and the app: one process serves the whole product.
  const backend = createBackend(config, database);
  const { app } = backend;

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    // Stop the background jobs, then the app, then the database pool.
    backend
      .stop()
      .then(() => database.close())
      .then(
        () => process.exit(0),
        (error: unknown) => {
          app.log.error({ err: error }, 'error during shutdown');
          process.exit(1);
        },
      );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  app
    .listen({ host: config.host, port: config.port })
    .then(() => backend.start())
    .catch((error: unknown) => {
      app.log.error({ err: error }, 'failed to start');
      process.exit(1);
    });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
