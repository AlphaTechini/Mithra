import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Starts what the test needs and returns the function that stops it:
 *  1. checks that the Canton sandbox answers (`scripts/sandbox.sh start`),
 *  2. builds the web app when `apps/web/build` is missing or older than its sources,
 *  3. starts the full-stack test server on a free port with a 5-second Hold countdown,
 *  4. waits until `/api/health` answers, and exports the address as E2E_BASE_URL.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX_URL = process.env['SANDBOX_URL'] ?? 'http://localhost:7575';
const HOLD_SECONDS = '5';
const START_TIMEOUT_MS = 180_000;

/** The newest modification time under `dir` (0 when it does not exist), skipping build output. */
function newestMtime(dir: string): number {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.svelte-kit' || entry.name === 'build') {
      continue;
    }
    const path = join(dir, entry.name);
    const time = entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs;
    if (time > newest) newest = time;
  }
  return newest;
}

function webBuildIsStale(): boolean {
  const index = join(ROOT, 'apps/web/build/index.html');
  if (!existsSync(index)) return true;
  const built = statSync(index).mtimeMs;
  const sources = [
    newestMtime(join(ROOT, 'apps/web/src')),
    newestMtime(join(ROOT, 'apps/web/static')),
    newestMtime(join(ROOT, 'packages/shared/src')),
    statSync(join(ROOT, 'apps/web/package.json')).mtimeMs,
    statSync(join(ROOT, 'apps/web/svelte.config.js')).mtimeMs,
  ];
  return Math.max(...sources) > built;
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit' });
    child.on('error', fail);
    child.on('exit', (code) =>
      code === 0 ? done() : fail(new Error(`${command} ${args.join(' ')} exited with ${code}`)),
    );
  });
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

async function sandboxIsUp(): Promise<boolean> {
  try {
    return (await fetch(`${SANDBOX_URL}/v2/version`, { signal: AbortSignal.timeout(5000) })).ok;
  } catch {
    return false;
  }
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((done) => {
    if (child.exitCode !== null || child.pid === undefined) return done();
    const pid = child.pid;
    const kill = (signal: NodeJS.Signals): void => {
      try {
        // The server runs in its own process group (pnpm, tsx and node), so signal the group.
        process.kill(-pid, signal);
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => kill('SIGKILL'), 10_000);
    child.once('exit', () => {
      clearTimeout(timer);
      done();
    });
    kill('SIGTERM');
  });
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!(await sandboxIsUp())) {
    throw new Error(
      `The Canton sandbox does not answer at ${SANDBOX_URL}. Start it with scripts/sandbox.sh start, then run the tests again.`,
    );
  }
  if (webBuildIsStale()) {
    process.stdout.write('[e2e] building the web app (pnpm --filter @mithra/web build)\n');
    await run('pnpm', ['--filter', '@mithra/web', 'build']);
  }

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logPath = join(ROOT, 'e2e', 'server.log');
  const log = createWriteStream(logPath);
  const server = spawn('pnpm', ['--filter', '@mithra/backend', 'e2e:server'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      E2E_PORT: String(port),
      E2E_HOLD_SECONDS: HOLD_SECONDS,
      E2E_HOST: '127.0.0.1',
    },
  });
  server.stdout?.pipe(log, { end: false });
  server.stderr?.pipe(log, { end: false });
  let exited = null as number | null;
  server.on('exit', (code) => (exited = code ?? -1));

  const started = Date.now();
  process.stdout.write(`[e2e] starting the full-stack server on ${baseUrl} (log: ${logPath})\n`);
  for (;;) {
    if (exited !== null) {
      const tail = existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-2000) : '';
      throw new Error(`The full-stack server exited with ${exited} before it was ready.\n${tail}`);
    }
    try {
      if ((await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() - started > START_TIMEOUT_MS) {
      await stop(server);
      throw new Error(`The full-stack server did not answer within ${START_TIMEOUT_MS / 1000}s.`);
    }
    await new Promise((wait) => setTimeout(wait, 500));
  }
  process.env['E2E_BASE_URL'] = baseUrl;
  process.stdout.write(`[e2e] ready after ${Math.round((Date.now() - started) / 1000)}s\n`);

  return async () => {
    await stop(server);
    log.end();
  };
}
