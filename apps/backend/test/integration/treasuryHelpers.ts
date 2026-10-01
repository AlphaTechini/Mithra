import { randomBytes } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import { sumDecimals, toDecimal, type CycleSummary } from '@mithra/shared';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { ActivityLog } from '../../src/activity/log';
import { sessionPlugin } from '../../src/auth/plugin';
import { createRoleResolver } from '../../src/auth/roles';
import { SessionService, SESSION_COOKIE } from '../../src/auth/sessions';
import type { Config } from '../../src/config/env';
import type { DatabaseHandle } from '../../src/db';
import { EventBus, type Published } from '../../src/events/bus';
import { FundingError, type Funding, type FundingResult } from '../../src/funding';
import { ApiError, errorBody, upstreamErrorResponse } from '../../src/http/errors';
import {
  createLedger,
  createdIn,
  type Ledger,
  type ProposalInput,
  type Transaction,
} from '../../src/ledger';
import { PartyNames } from '../../src/parties/names';
import {
  treasuryRoutes,
  type CycleQueries,
  type TreasuryRoutesDeps,
} from '../../src/routes/treasury';
import type { AssetAdapter, Holding } from '../../src/wallet';
import {
  EMPTY_EXTRA_ARGS,
  PARTY_NAMES,
  SANDBOX_URL,
  SANDBOX_USER,
  TEST_FACTORY,
  TEST_HOLDING,
  TEST_PREAPPROVAL,
  isoDate,
  localnetConfig,
  passingCheck,
  proRata,
  submitter,
  testLeg,
} from './helpers';

/** The parties of M3's world plus a fourth holder and a third approver. */
export const TREASURY_PARTY_NAMES = [...PARTY_NAMES, 'holderD', 'approver3'] as const;
export type TreasuryPartyName = (typeof TREASURY_PARTY_NAMES)[number];

export interface TreasuryWorld {
  parties: Record<TreasuryPartyName, string>;
  config: Config;
  ledger: Ledger;
  /** Test registry contracts: the transfer factory and a preapproval for each preapproved holder. */
  ids: { factoryCid: string; preapprovals: Record<string, string> };
}

/** Switches the test doubles misbehave on demand. */
export interface Switches {
  /** `asset.balance` fails (the registry or ledger is not reachable). */
  failBalance: boolean;
  /** `asset.acceptContext` fails: `registry` throws a RegistryError, `ledger` sends a bad disclosed contract. */
  acceptContext: 'ok' | 'registry' | 'ledger';
  /** `funding.createPreapproval` does nothing (the registry never reports it). */
  skipPreapproval: boolean;
  /** `funding.fundTreasury` fails with a FundingError. */
  failFunding: boolean;
}

/** The ledger client for allocating parties, before the parties exist. */
function adminLedger(): Ledger {
  return createLedger({
    ledger: {
      jsonApiUrl: SANDBOX_URL,
      userId: SANDBOX_USER,
      auth: { mode: 'none' },
      mithraPackage: '#mithra-v1',
      readAsTreasury: false,
    },
    parties: { treasury: 'unused', agent: 'unused', operator: 'unused' },
  });
}

/**
 * Allocates parties and builds what exists before anyone sets up the treasury: a test token
 * registry (funds for the treasury, a transfer factory, preapprovals for holders A and C) and
 * the treasury charter. No organization yet: the tests create it through the API.
 */
export async function createTreasuryWorld(): Promise<TreasuryWorld> {
  const admin = adminLedger();
  const suffix = randomBytes(3).toString('hex');
  const parties = {} as Record<TreasuryPartyName, string>;
  for (const name of TREASURY_PARTY_NAMES) {
    parties[name] = await admin.client.allocateParty(`${name}${suffix}`);
  }
  const base = localnetConfig(parties);
  if (base.network !== 'localnet') throw new Error('The test config must be a LocalNet one');
  // Every party has a name, so activity lines and tables read like the real demo.
  const config: Config = {
    ...base,
    localnet: {
      ...base.localnet,
      demoParties: [
        { partyId: parties.treasurer, displayName: 'Treasurer' },
        { partyId: parties.approver1, displayName: 'Approver 1' },
        { partyId: parties.approver2, displayName: 'Approver 2' },
        { partyId: parties.approver3, displayName: 'Approver 3' },
        { partyId: parties.holderA, displayName: 'Holder A' },
        { partyId: parties.holderB, displayName: 'Holder B' },
        { partyId: parties.holderC, displayName: 'Holder C' },
        { partyId: parties.holderD, displayName: 'Holder D' },
        { partyId: parties.outsider, displayName: 'Newcomer' },
      ],
    },
  };
  const ledger = createLedger(config);
  const as = submitter(ledger);
  const asset = { admin: parties.registryAdmin, id: 'CC' };

  await as.as(
    [parties.registryAdmin, parties.treasury],
    [
      {
        CreateCommand: {
          templateId: TEST_HOLDING,
          createArguments: {
            admin: parties.registryAdmin,
            owner: parties.treasury,
            instrumentId: asset,
            amount: '1000000.0',
          },
        },
      },
    ],
  );
  const factoryTx = await as.as(
    [parties.registryAdmin],
    [
      {
        CreateCommand: {
          templateId: TEST_FACTORY,
          createArguments: {
            admin: parties.registryAdmin,
            observers: [parties.treasury, parties.treasurer, parties.agent],
          },
        },
      },
    ],
  );
  const factoryCid =
    createdIn(factoryTx, 'Mithra.Test.Registry:TestTransferFactory')[0]?.contractId ?? '';
  const world: TreasuryWorld = { parties, config, ledger, ids: { factoryCid, preapprovals: {} } };
  for (const holder of [parties.holderA, parties.holderC]) {
    world.ids.preapprovals[holder] = await createTestPreapproval(world, holder);
  }

  await as.as(
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
  return world;
}

/** A standing preapproval of the test registry for `receiver`; returns its contract id. */
export async function createTestPreapproval(
  world: TreasuryWorld,
  receiver: string,
): Promise<string> {
  const { parties, ledger } = world;
  const tx = await submitter(ledger).as(
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

/**
 * A test-only `AssetAdapter` backed by the sandbox's test registry (`TestTransferFactory`,
 * `TestPreapproval`). A receiver with a preapproval gets a `direct` leg, others an `offer`; the
 * accept context is empty, as the test registry needs none.
 */
export function createTestAssetAdapter(world: TreasuryWorld, switches: Switches): AssetAdapter {
  const { parties, ledger } = world;
  const instrument = { admin: parties.registryAdmin, id: 'CC' };

  async function holdings(party: string): Promise<Holding[]> {
    const active = await ledger.client.activeContracts({
      parties: [party],
      templateIds: [TEST_HOLDING],
    });
    return active.flatMap((c) => {
      const p = c.payload as { owner: string; amount: string };
      return p.owner === party
        ? [{ contractId: c.contractId, owner: party, instrument, amount: p.amount, locked: false }]
        : [];
    });
  }

  return {
    instrument: () => ({ ...instrument }),
    holdings,
    async balance(party) {
      if (switches.failBalance) throw new Error('The test registry is down');
      return sumDecimals((await holdings(party)).map((h) => h.amount));
    },
    async transferLeg(input) {
      const preapprovals = await ledger.client.activeContracts({
        parties: [parties.agent],
        templateIds: [TEST_PREAPPROVAL],
      });
      const preapproval = preapprovals.find(
        (c) => (c.payload as { receiver: string }).receiver === input.receiver,
      );
      return {
        leg: testLeg(world.ids.factoryCid, input.receiver, preapproval?.contractId),
        disclosed: [],
        kind: preapproval ? 'direct' : 'offer',
      };
    },
    async acceptContext() {
      if (switches.acceptContext === 'registry') {
        const { RegistryError } = await import('../../src/wallet');
        throw new RegistryError('Registry exploded for receiver Holder B, amount 185.18', 500);
      }
      if (switches.acceptContext === 'ledger') {
        return {
          extraArgs: EMPTY_EXTRA_ARGS,
          disclosed: [
            {
              templateId: `${TEST_FACTORY}`,
              contractId: '00bogus',
              createdEventBlob: 'AAAA',
              synchronizerId: 'bogus::sync',
            },
          ],
        };
      }
      return { extraArgs: EMPTY_EXTRA_ARGS, disclosed: [] };
    },
  };
}

/**
 * A test-only `Funding`: LocalNet's Amulet tap and preapproval cannot run on the sandbox, so
 * this mints test-registry holdings and preapprovals instead and records the calls.
 */
export function createTestFunding(
  world: TreasuryWorld,
  switches: Switches,
): Funding & { calls: { fund: string[]; preapproval: string[] } } {
  const { parties, ledger } = world;
  const calls = { fund: [] as string[], preapproval: [] as string[] };
  return {
    calls,
    async fundTreasury(amount): Promise<FundingResult> {
      calls.fund.push(amount);
      if (switches.failFunding) {
        throw new FundingError('The registry refused the transfer to the treasury. Try again.');
      }
      const tx = await submitter(ledger).as(
        [parties.registryAdmin, parties.treasury],
        [
          {
            CreateCommand: {
              templateId: TEST_HOLDING,
              createArguments: {
                admin: parties.registryAdmin,
                owner: parties.treasury,
                instrumentId: { admin: parties.registryAdmin, id: 'CC' },
                amount,
              },
            },
          },
        ],
      );
      return {
        amount,
        acceptedPending: false,
        tapUpdateId: tx.updateId,
        transferUpdateId: tx.updateId,
        acceptUpdateId: null,
      };
    },
    async createPreapproval(receiver) {
      calls.preapproval.push(receiver);
      if (switches.skipPreapproval) return;
      await createTestPreapproval(world, receiver);
    },
  };
}

/** A stub of the cycle engine's `CycleQueries`; the tests edit `cycles` and `next` freely. */
export function createStubCycles(): CycleQueries & {
  cycles: CycleSummary[];
  next: { cycleId: string; label: string; at: string } | null;
} {
  const stub = {
    cycles: [] as CycleSummary[],
    next: null as { cycleId: string; label: string; at: string } | null,
    listCycles() {
      return Promise.resolve(stub.cycles);
    },
    nextCycle() {
      return Promise.resolve(stub.next);
    },
  };
  return stub;
}

export function cycleSummary(overrides: Partial<CycleSummary> & { cycleId: string }): CycleSummary {
  return {
    label: `Cycle ${overrides.cycleId}`,
    status: 'paid-automatically',
    total: '1000.0000000000',
    recordDate: '2026-08-31',
    approvals: null,
    flagCount: 0,
    trigger: 'schedule',
    createdAt: '2026-09-01T09:00:00.000Z',
    seeded: false,
    ...overrides,
  };
}

export interface TreasuryApp {
  app: FastifyInstance;
  bus: EventBus;
  /** Every event published on the bus, in order. */
  published: Published[];
  /** `cookie` header for a request signed in as `partyId`. */
  cookieFor(partyId: string): Promise<{ cookie: string }>;
}

export interface TreasuryAppOptions {
  /** Replaces the config (for example a MainNet one). */
  config?: Config;
  asset: AssetAdapter;
  funding: Funding;
  cycles: CycleQueries;
  routeOptions?: TreasuryRoutesDeps['options'];
  /** The `reconcilePayments` callback of the accept route (the cycle module's reconciler in the app). */
  reconcilePayments?: TreasuryRoutesDeps['reconcilePayments'];
}

/**
 * A test app with M3's cookie, session and role plumbing, the same error handling as the real
 * app, and the treasury routes with the test doubles.
 */
export async function buildTreasuryApp(
  world: TreasuryWorld,
  database: DatabaseHandle,
  options: TreasuryAppOptions,
): Promise<TreasuryApp> {
  const config = options.config ?? world.config;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error: FastifyError | ZodError | ApiError, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.status).send(errorBody(error.code, error.message));
    }
    const upstream = upstreamErrorResponse(error);
    if (upstream) return reply.code(upstream.status).send(upstream.body);
    if (error instanceof ZodError)
      return reply.code(400).send(errorBody('validation_error', error.message));
    const status = error.statusCode ?? 500;
    return reply
      .code(status)
      .send(
        errorBody(
          status >= 500 ? 'internal_error' : 'bad_request',
          status >= 500 ? 'Internal server error' : error.message,
        ),
      );
  });
  void app.register(fastifyCookie, { secret: config.sessionSecret });
  void app.register(sessionPlugin, {
    sessions: new SessionService(database.db),
    roleResolver: createRoleResolver({ reader: world.ledger.reader, db: database.db }),
  });
  const bus = new EventBus();
  const published: Published[] = [];
  bus.subscribe((p) => published.push(p));
  const names = new PartyNames(config, database.db, 0);
  const activity = new ActivityLog(database.db, bus, names);
  void app.register((scope, _options, done) => {
    treasuryRoutes(scope, {
      config,
      ledger: world.ledger,
      asset: options.asset,
      names,
      activity,
      bus,
      db: database.db,
      cycles: options.cycles,
      funding: options.funding,
      ...(options.routeOptions ? { options: options.routeOptions } : {}),
      ...(options.reconcilePayments ? { reconcilePayments: options.reconcilePayments } : {}),
    });
    done();
  });
  await app.ready();
  return {
    app,
    bus,
    published,
    async cookieFor(partyId) {
      const session = await app.sessions.create(partyId);
      return { cookie: `${SESSION_COOKIE}=${app.signCookie(session.id)}` };
    },
  };
}

/** A Mandate_Propose input with the pro-rata payouts of `holdings`. */
export function treasuryProposalInput(
  registerCid: string,
  holdings: { holder: string; units: number }[],
  options: { cycleId: string; total: string },
): ProposalInput {
  return {
    cycleId: options.cycleId,
    cycleLabel: `Cycle ${options.cycleId}`,
    attempt: 1,
    total: options.total,
    // Today: every unit tranche counts, whatever its effective date (the default is today).
    recordDate: isoDate(new Date()),
    trigger: 'TriggerSchedule',
    triggerDetail: 'Monthly schedule 0 9 1 * *',
    payouts: proRata(options.total, holdings),
    registerCid,
    inputFingerprints: [{ label: 'register', sha256: 'ab12' }],
    checks: [passingCheck('cap', 'Within the auto-execute cap')],
    memo: "Distribute the month's income pro rata.",
    memoSource: 'template',
    modelFingerprints: [],
    seeded: false,
  };
}

/** The transaction's created contract ids of one entity. */
export function createdIds(tx: Transaction, entity: string): string[] {
  return createdIn(tx, entity).map((c) => c.contractId);
}

/** True when `a` and `b` are the same decimal. */
export function sameDecimal(a: string, b: string): boolean {
  return toDecimal(a).eq(toDecimal(b));
}
