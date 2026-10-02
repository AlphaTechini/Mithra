import type { FastifyInstance } from 'fastify';
import { ActivityLog } from '../activity/log';
import { createAgent, type Agent } from '../agent/agent';
import { AiMemoWriter } from '../agent/memoWriter';
import { createPolicyDrafter, type PolicyDrafter } from '../agent/policyDrafter';
import type { AgentServices } from '../agent/services';
import { createAgentStore } from '../agent/store';
import { buildApp, type AppDeps } from '../app';
import { startGrantExpiry, type GrantExpiry } from '../audit/expiry';
import { createScopeDrafter, type ScopeDrafter } from '../audit/scope';
import type { Config } from '../config/env';
import { createCycleModule, type CycleModule } from '../cycle';
import type { DatabaseHandle } from '../db';
import { EventBus } from '../events/bus';
import { createFunding, type Funding } from '../funding';
import type { MandateSealer } from '../governance/sealer';
import { createHolderAdmin, type HolderAdmin } from '../holders/admin';
import { AutoReceiveStatus } from '../holders/autoReceive';
import { createHoldersReader } from '../holders/response';
import { createLedger, type Ledger } from '../ledger';
import { createLlm, type Llm } from '../llm/client';
import {
  MainnetPayouts,
  MainnetWallets,
  createMainnetAutoReceive,
  createMainnetRoutesPlugin,
} from '../mainnet';
import { PartyNames } from '../parties/names';
import { startScheduler, type Scheduler } from '../scheduler';
import { createAssetAdapter, type AssetAdapter } from '../wallet';
import { createAgentServices } from './agentServices';
import { createAuditModule } from '../audit/service';

/**
 * Replacements for the parts that talk to the outside world. The application passes none of them;
 * the full-stack test server (`test/e2e/server.ts`) passes test adapters for the asset, the sealer
 * and the model, and fast timings.
 */
export interface BackendOverrides {
  ledger?: Ledger;
  asset?: AssetAdapter;
  funding?: Funding;
  /** The sealer, or a function that builds it from the backend's own activity log. */
  sealer?: MandateSealer | ((deps: { activity: ActivityLog }) => MandateSealer);
  llm?: Llm;
  /** Seconds of the Hold countdown; default `config.holdCountdownSeconds`. */
  holdCountdownSeconds?: number;
  /** Milliseconds between reconciler passes. Default 10 000. */
  reconcileIntervalMs?: number;
  /** Replaces `fetch` for the MainNet Scan preapproval lookup (tests). */
  scanFetch?: typeof fetch;
  /** Milliseconds between grant expiry checks. Default 60 000. */
  expiryIntervalMs?: number;
  /** Session route options (the sign-in rate limit). */
  session?: AppDeps['session'];
  /** Milliseconds after which a live stream looks up its viewer's roles again. Default 15 000. */
  eventRoleRefreshMs?: number;
}

/** One process: the Fastify app plus every module and background job behind it. */
export interface Backend {
  app: FastifyInstance;
  config: Config;
  ledger: Ledger;
  asset: AssetAdapter;
  funding: Funding;
  bus: EventBus;
  names: PartyNames;
  activity: ActivityLog;
  cycle: CycleModule;
  services: AgentServices;
  agent: Agent;
  drafter: PolicyDrafter;
  scope: ScopeDrafter;
  holderAdmin: HolderAdmin;
  /** MainNet payouts only: the holders' Grofty wallets and the treasurer's payout records. */
  mainnet: { wallets: MainnetWallets; payouts: MainnetPayouts } | undefined;
  /** Starts the reconciler, the scheduler and the grant expiry job. Call once, before `listen`. */
  start(): void;
  /** Stops the jobs and closes the app. Does not close the database pool. */
  stop(): Promise<void>;
}

/**
 * Builds the whole backend from the configuration: ledger, asset adapter, one event bus, one
 * party-name lookup, one activity log, the cycle module (with the AI memo writer), funding, the
 * agent with its services, the policy drafter, the scope drafter, and the app that serves them.
 */
export function createBackend(
  config: Config,
  database: DatabaseHandle,
  overrides: BackendOverrides = {},
): Backend {
  const db = database.db;
  const ledger = overrides.ledger ?? createLedger(config);
  const asset = overrides.asset ?? createAssetAdapter(config, ledger.client);
  const bus = new EventBus();
  const names = new PartyNames(config, db);
  const activity = new ActivityLog(db, bus, names);
  const llm = overrides.llm ?? createLlm({ ...config.llm });

  // The app does not exist yet when the modules are built; they log through it once it does.
  const late: { app?: FastifyInstance } = {};
  const log = {
    warn: (object: unknown, message?: string): void => late.app?.log.warn(object, message),
    info: (object: unknown, message?: string): void => late.app?.log.info(object, message),
  };

  // MainNet payouts: records stay on LocalNet, the money moves in Grofty. The wallets are the
  // holders' registered MainNet parties.
  const wallets = config.network === 'mainnet' ? new MainnetWallets(db) : undefined;

  const sealer =
    typeof overrides.sealer === 'function' ? overrides.sealer({ activity }) : overrides.sealer;
  const holdCountdownSeconds = overrides.holdCountdownSeconds ?? config.holdCountdownSeconds;
  const cycle = createCycleModule({
    config,
    db,
    ledger,
    assets: asset,
    names,
    activity,
    bus,
    memoWriter: new AiMemoWriter({ llm }),
    log,
    ...(holdCountdownSeconds === undefined ? {} : { holdCountdownSeconds }),
    ...(sealer ? { sealer } : {}),
    ...(wallets ? { wallets } : {}),
    ...(overrides.reconcileIntervalMs === undefined
      ? {}
      : { reconcileIntervalMs: overrides.reconcileIntervalMs }),
  });
  const funding = overrides.funding ?? createFunding({ config, ledger, asset });

  const onAutoReceiveError = (holder: string, error: unknown): void =>
    log.warn({ err: error, holder }, 'could not read auto-receive status');
  const autoReceive =
    config.network === 'mainnet' && wallets
      ? createMainnetAutoReceive({
          scanUrl: config.mainnet.scanUrl,
          wallets,
          onError: onAutoReceiveError,
          ...(overrides.scanFetch ? { fetch: overrides.scanFetch } : {}),
        })
      : new AutoReceiveStatus({
          asset,
          treasury: config.parties.treasury,
          onError: onAutoReceiveError,
        });
  const payouts = wallets
    ? new MainnetPayouts({ config, db, ledger, names, activity, bus, cycles: cycle.cycles })
    : undefined;
  const holderAdmin = createHolderAdmin({ config, ledger, names, activity, bus, db });
  const services = createAgentServices({
    config,
    db,
    ledger,
    cycle,
    asset,
    names,
    holders: createHoldersReader({
      config,
      ledger,
      names,
      autoReceive,
      ...(wallets ? { wallets } : {}),
    }),
    holderAdmin,
  });

  // The grant expiry job starts with `start()`; the agent's tool reaches it through this handle.
  let expiry: GrantExpiry | undefined;
  const expiryHandle = {
    closeExpiredNow: () => {
      if (!expiry) return Promise.reject(new Error('The grant expiry job has not started.'));
      return expiry.closeExpiredNow();
    },
  };
  const audit = createAuditModule({ config, db, ledger, names, activity, bus });
  const scope = createScopeDrafter({ llm, catalog: audit.catalog });
  const agent = createAgent({
    llm,
    services,
    names,
    bus,
    db,
    activity,
    expiry: expiryHandle,
    scope,
    log,
    ...(config.llm.maxToolRounds === undefined ? {} : { maxToolRounds: config.llm.maxToolRounds }),
    ...(config.llm.strictTools === undefined ? {} : { strictTools: config.llm.strictTools }),
  });
  const drafter = createPolicyDrafter({ llm, services, store: createAgentStore(db) });

  const app = buildApp(config, {
    database,
    ledger,
    ...(overrides.session ? { session: overrides.session } : {}),
    modules: {
      bus,
      cycle: { routes: cycle.routes },
      treasury: {
        asset,
        names,
        activity,
        bus,
        cycles: cycle.queries,
        funding,
        // A holder's accept marks the Payment Paid at once instead of at the next pass.
        reconcilePayments: () => cycle.reconciler.reconcilePayments(),
        ...(wallets
          ? {
              mainnetWallets: wallets,
              // A holder connecting a wallet can unblock cycles that were waiting for it.
              walletConnected: async () => {
                for (const cycleId of await cycle.cycles.waitingCycleIds()) {
                  await cycle.cycles.advance(cycleId);
                }
              },
            }
          : {}),
        options: { autoReceive },
      },
      agent: { agent, drafter, scope },
      audit: { routes: audit.routes },
      ...(payouts ? { mainnet: { routes: createMainnetRoutesPlugin(payouts) } } : {}),
      ...(overrides.eventRoleRefreshMs === undefined
        ? {}
        : { events: { roleRefreshMs: overrides.eventRoleRefreshMs } }),
    },
  });
  late.app = app;

  let scheduler: Scheduler | undefined;
  let started = false;
  let stopped = false;

  return {
    app,
    config,
    ledger,
    asset,
    funding,
    bus,
    names,
    activity,
    cycle,
    services,
    agent,
    drafter,
    scope,
    holderAdmin,
    mainnet: wallets && payouts ? { wallets, payouts } : undefined,
    start() {
      if (started) return;
      started = true;
      cycle.reconciler.start();
      app.log.info('reconciler started');
      scheduler = startScheduler({
        services,
        ledger,
        db,
        bus,
        treasuryParty: config.parties.treasury,
        agentParty: config.parties.agent,
        activity,
        log,
      });
      app.log.info('scheduler started');
      expiry = startGrantExpiry({
        ledger,
        activity,
        bus,
        names,
        readAs: config.ledger.readAsTreasury ? [config.parties.treasury] : [],
        ...(overrides.expiryIntervalMs === undefined
          ? {}
          : { intervalMs: overrides.expiryIntervalMs }),
        log,
      });
      app.log.info('grant expiry started');
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      expiry?.stop();
      scheduler?.stop();
      cycle.reconciler.stop();
      cycle.cycles.dispose();
      await app.close();
    },
  };
}
