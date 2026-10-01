import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Config } from '../../src/config/env';
import { createDatabase, runMigrations, type DatabaseHandle } from '../../src/db';
import { FundingError, type Funding } from '../../src/funding';
import { createLedger, createdIn, type Ledger } from '../../src/ledger';
import { PartyNames } from '../../src/parties/names';
import { createPolicyDrafts } from '../../src/policy/drafts';
import { createBackend, type Backend } from '../../src/wiring/backend';
import { startLlmStub, type LlmStub } from '../llm-stub/server';
import { createTestSealer, testAssetAdapter } from '../integration/cycleHelpers';
import {
  SANDBOX_URL,
  SANDBOX_USER,
  TEST_FACTORY,
  TEST_HOLDING,
  TEST_PREAPPROVAL,
  resetDatabase,
} from '../integration/helpers';
import { demoLlmScript } from './llmScript';

/**
 * The full-stack test server: the real application (`createBackend`, so every module, route and
 * background job) against the Canton sandbox and PostgreSQL, with test-only replacements for what
 * LocalNet has and the sandbox does not:
 *  - the asset adapter and the funding are backed by the sandbox's test token registry
 *    (`TestHolding`, `TestTransferFactory`, `TestPreapproval`) instead of Amulet,
 *  - the Mandate sealer runs `Org_ApplySeal` as the treasury directly instead of BitSafe governance,
 *  - the language model is the stub server with a script for the demo prompts.
 * Used by the full-stack HTTP test, by Playwright and by `seed-localnet --sandbox`. It lives under
 * `test/` and must never be imported by application code.
 */

export const DEMO_PASSWORD = 'demo';

/** The parties of the demo, by the names the role switcher shows. */
export interface DemoParties {
  registryAdmin: string;
  treasury: string;
  treasurer: string;
  agent: string;
  operator: string;
  approver1: string;
  approver2: string;
  approver3: string;
  holderA: string;
  holderB: string;
  holderC: string;
  holderD: string;
  auditor: string;
}

const PARTY_KEYS: (keyof DemoParties)[] = [
  'registryAdmin',
  'treasury',
  'treasurer',
  'agent',
  'operator',
  'approver1',
  'approver2',
  'approver3',
  'holderA',
  'holderB',
  'holderC',
  'holderD',
  'auditor',
];

/** Display names of the role switcher, in the order the user flow lists them. */
const DEMO_NAMES: { key: keyof DemoParties; displayName: string }[] = [
  { key: 'treasurer', displayName: 'Treasurer' },
  { key: 'approver1', displayName: 'Approver 1' },
  { key: 'approver2', displayName: 'Approver 2' },
  { key: 'approver3', displayName: 'Approver 3' },
  { key: 'holderA', displayName: 'Holder A' },
  { key: 'holderB', displayName: 'Holder B' },
  { key: 'holderC', displayName: 'Holder C' },
  { key: 'holderD', displayName: 'Holder D' },
  { key: 'auditor', displayName: 'Auditor' },
];

/** What a persisted world remembers, so a second run of the seed script finds the same fund. */
interface WorldState {
  parties: DemoParties;
  factoryCid: string;
  preapprovals: Record<string, string>;
}

export interface FullStackOptions {
  /** PostgreSQL database; it is emptied unless `statePath` points at a world that still exists. */
  databaseUrl?: string;
  /** Test CC minted to the treasury when the world is created. Default 50 000. */
  initialFunds?: string;
  /** Seconds of the Hold countdown. Default 5. */
  holdCountdownSeconds?: number;
  /** Milliseconds between reconciler passes. Default 1000. */
  reconcileIntervalMs?: number;
  /** The built web app. Default `apps/web/build` when it exists. */
  webDistDir?: string | null;
  /** Keep the world in this file and reuse it (and the database) on the next boot. */
  statePath?: string;
  logLevel?: Config['logLevel'];
}

export interface FullStack {
  backend: Backend;
  config: Config;
  database: DatabaseHandle;
  ledger: Ledger;
  parties: DemoParties;
  stub: LlmStub;
  /** True when the world already existed (persisted state reused). */
  reused: boolean;
  /** Starts the background jobs and listens; resolves with the base URL. */
  listen(port?: number, host?: string): Promise<string>;
  /** Adds test CC to the treasury. */
  addFunds(amount: string): Promise<void>;
  /** Stops everything: jobs, app, stub, database pool. */
  close(): Promise<void>;
}

const DEFAULT_DATABASE_URL =
  process.env['E2E_DATABASE_URL'] ??
  process.env['DATABASE_URL_TEST_MW'] ??
  'postgres://mithra:mithra@localhost:5432/mithra_test_mw';

function repoWebBuild(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const build = resolve(here, '../../../web/build');
  return existsSync(join(build, 'index.html')) ? build : undefined;
}

function submit(
  ledger: Ledger,
  actAs: string[],
  commands: Parameters<Ledger['client']['submit']>[0]['commands'],
) {
  return ledger.client.submit({ actAs, commands, shape: 'LEDGER_EFFECTS' });
}

function configFor(
  parties: DemoParties,
  stub: LlmStub,
  options: FullStackOptions,
  databaseUrl: string,
): Config {
  const node = (id: string, name: string, operator: string, autoConfirm: boolean) => ({
    id,
    name,
    operator,
    jsonApiUrl: SANDBOX_URL,
    decmanUrl: 'http://localhost:1',
    autoConfirm,
  });
  const webDistDir =
    options.webDistDir === null ? undefined : (options.webDistDir ?? repoWebBuild());
  return {
    network: 'localnet',
    host: '127.0.0.1',
    port: 0,
    webOrigin: 'http://localhost:5173',
    webDistDir,
    logLevel: options.logLevel ?? 'warn',
    holdCountdownSeconds: options.holdCountdownSeconds ?? 5,
    databaseUrl,
    sessionSecret: 'full-stack-test-session-secret-0123456789',
    llm: { baseUrl: stub.baseUrl, apiKey: 'stub', model: 'stub-model', timeoutMs: 10_000 },
    ledger: {
      jsonApiUrl: SANDBOX_URL,
      userId: SANDBOX_USER,
      auth: { mode: 'none' },
      mithraPackage: '#mithra-v1',
      readAsTreasury: true,
    },
    parties: { treasury: parties.treasury, agent: parties.agent, operator: parties.operator },
    asset: { adminParty: parties.registryAdmin, id: 'CC', symbol: 'CC' },
    registryUrl: 'http://localhost:1/unused',
    localnet: {
      demoPassword: DEMO_PASSWORD,
      demoParties: DEMO_NAMES.map((d) => ({ partyId: parties[d.key], displayName: d.displayName })),
      nodes: [
        node('a', 'Node A', 'Operator A', true),
        node('b', 'Node B', 'Operator B', true),
        node('c', 'Node C', 'Operator C', false),
      ],
      decmanGovernanceThreshold: 2,
      decmanGovernanceRulesCid: '00rules',
      decmanMemberParties: { a: 'member-a', b: 'member-b', c: 'member-c' },
    },
  };
}

/** Allocates the parties and builds what exists before anyone sets up the treasury. */
async function createWorld(initialFunds: string): Promise<WorldState> {
  const suffix = randomBytes(3).toString('hex');
  const bootstrap = createLedger({
    ledger: {
      jsonApiUrl: SANDBOX_URL,
      userId: SANDBOX_USER,
      auth: { mode: 'none' },
      mithraPackage: '#mithra-v1',
      readAsTreasury: false,
    },
    parties: { treasury: 'unused', agent: 'unused', operator: 'unused' },
  });
  const parties = {} as DemoParties;
  for (const key of PARTY_KEYS) {
    parties[key] = await bootstrap.client.allocateParty(`${key}${suffix}`);
  }
  const ledger = createLedger({
    ledger: bootstrapLedgerConfig(),
    parties: { treasury: parties.treasury, agent: parties.agent, operator: parties.operator },
  });
  const asset = { admin: parties.registryAdmin, id: 'CC' };
  const watchers = [parties.treasury, parties.treasurer, parties.agent];

  // The test registry: funds for the treasury, a transfer factory, preapprovals for A to C (D has
  // none, so a payment to Holder D waits for them to accept).
  await submit(
    ledger,
    [parties.registryAdmin, parties.treasury],
    [holdingCommand(parties, asset, initialFunds)],
  );
  const factoryTx = await submit(
    ledger,
    [parties.registryAdmin],
    [
      {
        CreateCommand: {
          templateId: TEST_FACTORY,
          createArguments: { admin: parties.registryAdmin, observers: watchers },
        },
      },
    ],
  );
  const factoryCid =
    createdIn(factoryTx, 'Mithra.Test.Registry:TestTransferFactory')[0]?.contractId ?? '';
  const preapprovals: Record<string, string> = {};
  for (const holder of [parties.holderA, parties.holderB, parties.holderC]) {
    preapprovals[holder] = await createPreapproval(ledger, parties, holder);
  }

  // The treasury charter, created by the treasury as the LocalNet scripts do.
  await submit(
    ledger,
    [parties.treasury],
    [
      ledger.commands.createTreasuryCharter({
        treasury: parties.treasury,
        treasurer: parties.treasurer,
        agent: parties.agent,
        operator: parties.operator,
      }),
    ],
  );
  return { parties, factoryCid, preapprovals };
}

function bootstrapLedgerConfig() {
  return {
    jsonApiUrl: SANDBOX_URL,
    userId: SANDBOX_USER,
    auth: { mode: 'none' as const },
    mithraPackage: '#mithra-v1',
    readAsTreasury: true,
  };
}

function holdingCommand(
  parties: DemoParties,
  asset: { admin: string; id: string },
  amount: string,
) {
  return {
    CreateCommand: {
      templateId: TEST_HOLDING,
      createArguments: {
        admin: parties.registryAdmin,
        owner: parties.treasury,
        instrumentId: asset,
        amount,
      },
    },
  };
}

async function createPreapproval(
  ledger: Ledger,
  parties: DemoParties,
  receiver: string,
): Promise<string> {
  const tx = await submit(
    ledger,
    [parties.registryAdmin, receiver],
    [
      {
        CreateCommand: {
          templateId: TEST_PREAPPROVAL,
          createArguments: {
            admin: parties.registryAdmin,
            receiver,
            observers: [parties.treasury, parties.treasurer, parties.agent],
          },
        },
      },
    ],
  );
  return createdIn(tx, 'Mithra.Test.Registry:TestPreapproval')[0]?.contractId ?? '';
}

/** Test funds and auto-receive on the test registry (LocalNet's tap and preapproval need Amulet). */
function testFunding(
  ledger: Ledger,
  parties: DemoParties,
  preapprovals: Record<string, string>,
  onChange: () => void,
): Funding {
  const asset = { admin: parties.registryAdmin, id: 'CC' };
  return {
    async fundTreasury(amount) {
      try {
        const tx = await submit(
          ledger,
          [parties.registryAdmin, parties.treasury],
          [holdingCommand(parties, asset, amount)],
        );
        return {
          amount,
          acceptedPending: false,
          tapUpdateId: tx.updateId,
          transferUpdateId: tx.updateId,
          acceptUpdateId: null,
        };
      } catch (error) {
        throw new FundingError('The test registry did not accept the funds. Try again.', {
          cause: error,
        });
      }
    },
    async createPreapproval(receiver) {
      if (preapprovals[receiver]) return;
      preapprovals[receiver] = await createPreapproval(ledger, parties, receiver);
      onChange();
    },
  };
}

async function worldStillExists(ledger: Ledger): Promise<boolean> {
  const [charter, organization] = await Promise.all([
    ledger.reader.charter(),
    ledger.reader.organization(),
  ]);
  return charter !== null || organization !== null;
}

/** Boots the whole application against the sandbox. Does not listen until `listen` is called. */
export async function bootFullStack(options: FullStackOptions = {}): Promise<FullStack> {
  const databaseUrl = options.databaseUrl ?? DEFAULT_DATABASE_URL;
  const stub = await startLlmStub();
  stub.always(demoLlmScript());

  // Reuse a persisted world when it is still on the ledger; otherwise start a new one.
  let state: WorldState | undefined;
  if (options.statePath && existsSync(options.statePath)) {
    const saved = JSON.parse(readFileSync(options.statePath, 'utf8')) as WorldState;
    const probe = createLedger({
      ledger: bootstrapLedgerConfig(),
      parties: {
        treasury: saved.parties.treasury,
        agent: saved.parties.agent,
        operator: saved.parties.operator,
      },
    });
    if (await worldStillExists(probe)) state = saved;
  }
  const reused = state !== undefined;
  state ??= await createWorld(options.initialFunds ?? '50000');
  const persist = (): void => {
    if (options.statePath && state)
      writeFileSync(options.statePath, JSON.stringify(state, null, 2));
  };
  persist();
  const { parties } = state;
  const preapprovals = state.preapprovals;

  const database = createDatabase(databaseUrl);
  if (!reused) await resetDatabase(database);
  await runMigrations(database.db);

  const config = configFor(parties, stub, options, databaseUrl);
  const ledger = createLedger(config);
  const asset = testAssetAdapter(
    ledger,
    { admin: parties.registryAdmin, id: 'CC' },
    state.factoryCid,
    preapprovals,
  );
  const funding = testFunding(ledger, parties, preapprovals, persist);
  const names = new PartyNames(config, database.db);
  const drafts = createPolicyDrafts({ config, db: database.db, ledger, names });
  const sealer = createTestSealer({ config, ledger, parties, names }, drafts);

  const backend = createBackend(config, database, {
    ledger,
    asset,
    funding,
    sealer,
    holdCountdownSeconds: options.holdCountdownSeconds ?? 5,
    reconcileIntervalMs: options.reconcileIntervalMs ?? 1000,
    // Many sign-ins per minute are normal for a test run.
    session: { signInLimit: { limit: 1000, windowMs: 60_000 } },
  });

  let closed = false;
  return {
    backend,
    config,
    database,
    ledger,
    parties,
    stub,
    reused,
    async listen(port = 0, host = '127.0.0.1') {
      backend.start();
      await backend.app.listen({ port, host });
      const address = backend.app.server.address();
      const actual = typeof address === 'object' && address ? address.port : port;
      return `http://${host}:${actual}`;
    },
    async addFunds(amount) {
      await submit(
        ledger,
        [parties.registryAdmin, parties.treasury],
        [holdingCommand(parties, { admin: parties.registryAdmin, id: 'CC' }, amount)],
      );
    },
    async close() {
      if (closed) return;
      closed = true;
      await backend.stop();
      await stub.close();
      await database.close();
    },
  };
}

/** `pnpm --filter @mithra/backend e2e:server`: boots the stack and listens on E2E_PORT (default 8788). */
async function main(): Promise<void> {
  const port = Number(process.env['E2E_PORT'] ?? 8788);
  const stack = await bootFullStack({
    logLevel: (process.env['LOG_LEVEL'] as Config['logLevel'] | undefined) ?? 'info',
    ...(process.env['E2E_HOLD_SECONDS']
      ? { holdCountdownSeconds: Number(process.env['E2E_HOLD_SECONDS']) }
      : {}),
  });
  const url = await stack.listen(port, process.env['E2E_HOST'] ?? '127.0.0.1');
  const web = stack.config.webDistDir
    ? 'serving the built web app'
    : 'no web build found (API only)';
  process.stdout.write(
    [
      `Mithra full-stack test server: ${url} (${web})`,
      `Demo password: ${DEMO_PASSWORD}`,
      `Treasury charter exists; create the organization as "Treasurer". Holder D has no auto-receive.`,
      '',
    ].join('\n'),
  );
  const shutdown = (): void => {
    stack.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  });
}
