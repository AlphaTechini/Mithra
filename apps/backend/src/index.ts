import { buildApp } from './app';
import { ConfigError, loadConfig, loadDotEnv, type Config } from './config/env';
import { createDatabase, runMigrations } from './db';
import { createLedger } from './ledger';

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

  const ledger = createLedger(config);
  const app = buildApp(config, { database, ledger });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    app
      .close()
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

  app.listen({ host: config.host, port: config.port }).catch((error: unknown) => {
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
