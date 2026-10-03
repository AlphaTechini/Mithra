import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

/**
 * The happy path of userflow section 0 in a real browser, against the full-stack test server
 * (`pnpm --filter @mithra/backend e2e:server`: the real app on the Canton sandbox with a stub
 * model). `global-setup.ts` builds the web app when it is stale, starts that server on a free port
 * and exports its address as E2E_BASE_URL.
 *
 * Browser: the pre-installed Chromium in /opt/pw-browsers (no download), or the one named by
 * E2E_CHROMIUM_PATH. Without either, Playwright uses the browser `npx playwright install chromium`
 * put in its own cache (what CI does).
 */
const PREINSTALLED = '/opt/pw-browsers/chromium';
const executablePath =
  process.env['E2E_CHROMIUM_PATH'] ?? (existsSync(PREINSTALLED) ? PREINSTALLED : undefined);

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  globalSetup: './global-setup.ts',
  // One long test walks the whole story: every step builds on the one before.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 360_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  outputDir: './test-results',
  use: {
    headless: true,
    viewport: { width: 1280, height: 900 },
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      // The pre-installed browser runs as root in a container.
      args: ['--no-sandbox'],
    },
  },
});
