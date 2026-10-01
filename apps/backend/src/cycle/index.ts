import type { FastifyPluginAsync } from 'fastify';
import type { ActivityLog } from '../activity/log';
import type { Config } from '../config/env';
import type { Database } from '../db';
import type { EventBus } from '../events/bus';
import { createDecmanSealer } from '../governance/decman';
import { createMainnetSealer } from '../governance/mainnet';
import { createSealStore, type MandateSealer } from '../governance/sealer';
import type { Ledger } from '../ledger';
import type { PartyNames } from '../parties/names';
import { createPolicyDrafts, type PolicyDrafts } from '../policy/drafts';
import { createCycleRoutesPlugin } from '../routes/cycles';
import type { AssetAdapter } from '../wallet';
import { createCycleService, type CycleQueries, type CycleService } from './engine';
import type { PayoutExecutor } from './executor';
import type { MemoWriter } from './memo';
import { createReconciler, type Reconciler } from './reconcile';

export * from './engine';
export * from './memo';
export { startReconciler, createReconciler, classifyArchive } from './reconcile';
export type { Reconciler, ReconcileReport } from './reconcile';

export interface CycleModuleDeps {
  config: Config;
  db: Database;
  ledger: Pick<Ledger, 'client' | 'reader' | 'commands'>;
  assets: AssetAdapter;
  names: PartyNames;
  activity: ActivityLog;
  bus: EventBus;
  /** The memo writer; default: the deterministic template writer. The AI writer (M5) plugs in here. */
  memoWriter?: MemoWriter;
  /** Replaces the sealer (tests); default: DecMan on LocalNet, Grofty (not yet) on MainNet. */
  sealer?: MandateSealer;
  /** Replaces the agent payout executor (tests). */
  agentExecutor?: PayoutExecutor;
  holdCountdownSeconds?: number;
  now?: () => Date;
  /** Run the in-process Hold timers. Default true. */
  timers?: boolean;
  /** Milliseconds between reconciler passes. Default 10 000. */
  reconcileIntervalMs?: number;
  fetch?: typeof fetch;
}

export interface CycleModule {
  cycles: CycleService;
  /** What the overview route needs: the cycle list and the next scheduled cycle. */
  queries: CycleQueries;
  sealer: MandateSealer;
  drafts: PolicyDrafts;
  /** Not started yet: call `reconciler.start()` at boot and `reconciler.stop()` at shutdown. */
  reconciler: Reconciler;
  /** A Fastify plugin: `app.register(module.routes)` after the session plugin. */
  routes: FastifyPluginAsync;
}

/** Builds the cycle engine, the Mandate sealer, the policy drafts, the reconciler and the routes. */
export function createCycleModule(deps: CycleModuleDeps): CycleModule {
  const drafts = createPolicyDrafts({
    config: deps.config,
    db: deps.db,
    ledger: deps.ledger,
    names: deps.names,
  });
  const cycles = createCycleService({
    config: deps.config,
    db: deps.db,
    ledger: deps.ledger,
    assets: deps.assets,
    names: deps.names,
    activity: deps.activity,
    bus: deps.bus,
    ...(deps.memoWriter ? { memoWriter: deps.memoWriter } : {}),
    ...(deps.holdCountdownSeconds === undefined
      ? {}
      : { holdCountdownSeconds: deps.holdCountdownSeconds }),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.timers === undefined ? {} : { timers: deps.timers }),
    ...(deps.agentExecutor ? { agentExecutor: deps.agentExecutor } : {}),
  });
  const store = createSealStore(deps.db);
  const sealPrepare = { config: deps.config, ledger: deps.ledger, drafts, names: deps.names };
  const sealer =
    deps.sealer ??
    (deps.config.network === 'localnet'
      ? createDecmanSealer({
          ...sealPrepare,
          config: deps.config,
          ledger: deps.ledger,
          store,
          activity: deps.activity,
          bus: deps.bus,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
          ...(deps.now ? { now: deps.now } : {}),
        })
      : createMainnetSealer({ ...sealPrepare, config: deps.config, store }));
  const reconciler = createReconciler(
    {
      config: deps.config,
      db: deps.db,
      ledger: deps.ledger,
      cycles,
      names: deps.names,
      activity: deps.activity,
      bus: deps.bus,
      sealer,
    },
    deps.reconcileIntervalMs,
  );
  const routes = createCycleRoutesPlugin({
    config: deps.config,
    cycles,
    sealer,
    drafts,
    ledger: deps.ledger,
    names: deps.names,
    db: deps.db,
  });
  return { cycles, queries: cycles, sealer, drafts, reconciler, routes };
}
