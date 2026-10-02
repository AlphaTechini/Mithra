import { randomBytes, randomUUID } from 'node:crypto';
import type { SealStatus } from '@mithra/shared';
import { ActivityLog } from '../../src/activity/log';
import type { Config } from '../../src/config/env';
import { createCycleModule, type CycleModule, type CycleModuleDeps } from '../../src/cycle';
import { computeProRata, unitsAt } from '../../src/cycle/prorata';
import { fingerprint } from '../../src/cycle/fingerprint';
import type { DatabaseHandle } from '../../src/db';
import { EventBus } from '../../src/events/bus';
import {
  prepareSeal,
  sealedText,
  sealRequestedText,
  type DraftSource,
  type MandateSealer,
} from '../../src/governance/sealer';
import {
  choiceResults,
  createLedger,
  createdIn,
  type Ledger,
  type Contract,
  type MandateTerms,
  type Proposal,
  type ProposalInput,
  type SubmitInput,
  type Transaction,
} from '../../src/ledger';
import { PartyNames } from '../../src/parties/names';
import { createPolicyDrafts } from '../../src/policy/drafts';
import { createTokenStandardAdapter, type AssetAdapter } from '../../src/wallet';
import {
  EMPTY_EXTRA_ARGS,
  SANDBOX_URL,
  SANDBOX_USER,
  TEST_FACTORY,
  TEST_HOLDING,
  TEST_PREAPPROVAL,
  TRANSFER_INSTRUCTION_INTERFACE,
  daysAgo,
  defaultTerms,
  isoDate,
  localnetConfig,
  testLeg,
} from './helpers';

export const DATABASE_URL_M4 =
  process.env['DATABASE_URL_TEST_M4'] ?? 'postgres://mithra:mithra@localhost:5432/mithra_test_m4';

export const CYCLE_PARTY_NAMES = [
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
  'outsider',
  /** Signed in, with no role at all: a prospective auditor. */
  'prospect',
] as const;
export type CycleParty = (typeof CYCLE_PARTY_NAMES)[number];
export type HolderName = Extract<CycleParty, `holder${string}`>;

export interface HolderSpec {
  name: HolderName;
  units: number;
  /** Days ago the units became effective. */
  daysAgo: number;
  /** True: the holder pre-approved transfers (one-step payment). False: a pending transfer. */
  preapproval: boolean;
}

export interface CycleWorldOptions {
  holders: HolderSpec[];
  /** Funds of the treasury, a decimal string. */
  funds: string;
  terms?: Partial<MandateTerms>;
}

export interface CycleWorld {
  parties: Record<CycleParty, string>;
  config: Config;
  ledger: Ledger;
  db: DatabaseHandle;
  asset: { admin: string; id: string };
  factoryCid: string;
  /** Preapproval contract ids by holder party. */
  preapprovals: Record<string, string>;
  adapter: AssetAdapter;
  names: PartyNames;
  bus: EventBus;
  activity: ActivityLog;
  terms: MandateTerms;
  /** Every submission made through `ledger.client`, in order. */
  submits: { actAs: string[]; choices: string[] }[];
}

/** A ledger client for allocating parties before the world exists. */
const admin: Ledger = createLedger({
  ledger: {
    jsonApiUrl: SANDBOX_URL,
    userId: SANDBOX_USER,
    auth: { mode: 'none' },
    mithraPackage: '#mithra-v1',
    readAsTreasury: false,
  },
  parties: { treasury: 'unused', agent: 'unused', operator: 'unused' },
});

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until `check` returns a value that is not undefined/false, or throws after `timeoutMs`. */
export async function eventually<T>(
  check: () => Promise<T | undefined | false>,
  what: string,
  timeoutMs = 15_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const result = await check();
    if (result !== undefined && result !== false) return result;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await sleep(150);
  }
}

function choicesOf(input: SubmitInput): string[] {
  return input.commands.map((c) =>
    'ExerciseCommand' in c
      ? c.ExerciseCommand.choice
      : `create ${c.CreateCommand.templateId.split(':').pop() ?? ''}`,
  );
}

/**
 * A test-only asset adapter over the sandbox's test token registry (`TestHolding`,
 * `TestTransferFactory`, `TestPreapproval`). Holdings and balance use the real token standard
 * adapter (the Holding interface); legs come from the test factory, one-step for holders with a
 * preapproval and a pending transfer for the others. Not used by the application.
 */
export function testAssetAdapter(
  ledger: Ledger,
  asset: { admin: string; id: string },
  factoryCid: string,
  preapprovals: Record<string, string>,
): AssetAdapter {
  const real = createTokenStandardAdapter({
    ledger: ledger.client,
    registryUrl: 'http://localhost:1/unused',
    instrument: asset,
  });
  return {
    instrument: () => real.instrument(),
    holdings: (party) => real.holdings(party),
    balance: (party) => real.balance(party),
    transferLeg: ({ receiver }) =>
      Promise.resolve({
        leg: testLeg(factoryCid, receiver, preapprovals[receiver]),
        disclosed: [],
        kind: preapprovals[receiver] ? ('direct' as const) : ('offer' as const),
      }),
    acceptContext: () => Promise.resolve({ extraArgs: EMPTY_EXTRA_ARGS, disclosed: [] }),
  };
}

async function submitAs(
  ledger: Ledger,
  actAs: string[],
  commands: SubmitInput['commands'],
  readAs: string[] = [],
): Promise<Transaction> {
  return ledger.client.submit({ actAs, readAs, commands, shape: 'LEDGER_EFFECTS' });
}

/**
 * Allocates parties and builds one organization on the sandbox: a test token registry with funds,
 * a charter, an organization, a sealed Mandate (as the treasury, the MainNet-style path) and units
 * for the holders in `options`.
 */
export async function createCycleWorld(
  db: DatabaseHandle,
  options: CycleWorldOptions,
): Promise<CycleWorld> {
  const suffix = randomBytes(3).toString('hex');
  const parties = {} as Record<CycleParty, string>;
  for (const name of CYCLE_PARTY_NAMES) {
    parties[name] = await admin.client.allocateParty(`${name}${suffix}`);
  }
  const base = localnetConfig(parties);
  const displayNames: Record<string, string> = {
    [parties.treasurer]: 'Treasurer',
    [parties.approver1]: 'Approver 1',
    [parties.approver2]: 'Approver 2',
    [parties.approver3]: 'Approver 3',
    [parties.holderA]: 'Holder A',
    [parties.holderB]: 'Holder B',
    [parties.holderC]: 'Holder C',
    [parties.holderD]: 'Holder D',
    [parties.auditor]: 'Auditor',
    [parties.outsider]: 'Newcomer',
    [parties.prospect]: 'Prospect',
  };
  const config = {
    ...base,
    databaseUrl: DATABASE_URL_M4,
    localnet: {
      ...base.localnet,
      demoParties: Object.entries(displayNames).map(([partyId, displayName]) => ({
        partyId,
        displayName,
      })),
    },
  };
  const ledger = createLedger(config);
  const submits: CycleWorld['submits'] = [];
  const original = ledger.client.submit.bind(ledger.client);
  (ledger.client as { submit: typeof original }).submit = (input) => {
    submits.push({ actAs: input.actAs, choices: choicesOf(input) });
    return original(input);
  };
  const asset = { admin: parties.registryAdmin, id: 'CC' };

  // Test token registry: funds for the treasury, a factory, a preapproval per preapproved holder.
  await submitAs(
    ledger,
    [parties.registryAdmin, parties.treasury],
    [
      {
        CreateCommand: {
          templateId: TEST_HOLDING,
          createArguments: {
            admin: parties.registryAdmin,
            owner: parties.treasury,
            instrumentId: asset,
            amount: options.funds,
          },
        },
      },
    ],
  );
  const factoryTx = await submitAs(
    ledger,
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
  const preapprovals: Record<string, string> = {};
  for (const spec of options.holders) {
    if (!spec.preapproval) continue;
    const holder = parties[spec.name];
    const tx = await submitAs(
      ledger,
      [parties.registryAdmin, holder],
      [
        {
          CreateCommand: {
            templateId: TEST_PREAPPROVAL,
            createArguments: {
              admin: parties.registryAdmin,
              receiver: holder,
              observers: [parties.treasury, parties.treasurer, parties.agent],
            },
          },
        },
      ],
    );
    preapprovals[holder] =
      createdIn(tx, 'Mithra.Test.Registry:TestPreapproval')[0]?.contractId ?? '';
  }

  // Charter (treasury), organization (treasurer), sealed Mandate (treasury).
  const approvers = [parties.approver1, parties.approver2, parties.approver3];
  const terms: MandateTerms = {
    ...defaultTerms(asset, approvers),
    unitChangePct: '100.0000000000',
    ...options.terms,
  };
  const { commands } = ledger;
  const charterTx = await submitAs(
    ledger,
    [parties.treasury],
    [
      commands.createTreasuryCharter({
        treasury: parties.treasury,
        treasurer: parties.treasurer,
        agent: parties.agent,
        operator: parties.operator,
      }),
    ],
  );
  const charterCid = createdIn(charterTx, 'Mithra.Charter:TreasuryCharter')[0]?.contractId ?? '';
  const orgTx = await submitAs(
    ledger,
    [parties.treasurer],
    [
      commands.charterCreateOrganization(charterCid, {
        name: 'Acme Fund',
        asset,
        approvers: terms.approvers,
        approvalThreshold: terms.approvalThreshold,
      }),
    ],
  );
  const { orgCid: org0, registerCid: register0 } = choiceResults.charterCreateOrganization(orgTx);
  const sealTx = await submitAs(
    ledger,
    [parties.treasurer],
    [
      commands.createMandateSealRequest({
        treasury: parties.treasury,
        treasurer: parties.treasurer,
        agent: parties.agent,
        terms,
        agentExecutes: true,
        summary: 'Test terms',
        summaryFingerprint: fingerprint('Test terms'),
        requestedAt: new Date(),
      }),
    ],
  );
  const sealRequestCid =
    createdIn(sealTx, 'Mithra.Mandate:MandateSealRequest')[0]?.contractId ?? '';
  const applyTx = await submitAs(
    ledger,
    [parties.treasury],
    [commands.orgApplySeal(org0, { sealRequestCid, currentMandateCid: null })],
  );
  const { orgCid } = choiceResults.orgApplySeal(applyTx);
  let registerCid = register0;
  for (const spec of options.holders) {
    const tx = await submitAs(
      ledger,
      [parties.treasurer],
      [
        commands.orgIssueUnits(orgCid, {
          registerCid,
          holder: parties[spec.name],
          units: spec.units,
          effectiveDate: isoDate(daysAgo(spec.daysAgo)),
          seeded: false,
        }),
      ],
    );
    registerCid = choiceResults.orgIssueUnits(tx).registerCid;
  }

  const names = new PartyNames(config, db.db);
  const bus = new EventBus();
  const activity = new ActivityLog(db.db, bus, names);
  return {
    parties,
    config,
    ledger,
    db,
    asset,
    factoryCid,
    preapprovals,
    adapter: testAssetAdapter(ledger, asset, factoryCid, preapprovals),
    names,
    bus,
    activity,
    terms,
    submits,
  };
}

/** Issues more units to a holder (the register is recreated, so its id is read fresh). */
export async function issueUnits(
  world: CycleWorld,
  holder: HolderName,
  units: number,
  daysAgoEffective: number,
): Promise<void> {
  const [org, register] = await Promise.all([
    world.ledger.reader.organization(),
    world.ledger.reader.register(),
  ]);
  if (!org || !register) throw new Error('world has no organization');
  await submitAs(
    world.ledger,
    [world.parties.treasurer],
    [
      world.ledger.commands.orgIssueUnits(org.contractId, {
        registerCid: register.contractId,
        holder: world.parties[holder],
        units,
        effectiveDate: isoDate(daysAgo(daysAgoEffective)),
        seeded: false,
      }),
    ],
  );
}

/** Adds funds to the treasury (a new test holding). */
export async function addFunds(world: CycleWorld, amount: string): Promise<void> {
  await submitAs(
    world.ledger,
    [world.parties.registryAdmin, world.parties.treasury],
    [
      {
        CreateCommand: {
          templateId: TEST_HOLDING,
          createArguments: {
            admin: world.parties.registryAdmin,
            owner: world.parties.treasury,
            instrumentId: world.asset,
            amount,
          },
        },
      },
    ],
  );
}

/** The holder accepts a pending transfer in the registry (what the holder's wallet does). */
export async function acceptTransfer(
  world: CycleWorld,
  holder: HolderName,
  instructionCid: string,
): Promise<Transaction> {
  return submitAs(
    world.ledger,
    [world.parties[holder]],
    [
      {
        ExerciseCommand: {
          templateId: TRANSFER_INSTRUCTION_INTERFACE,
          contractId: instructionCid,
          choice: 'TransferInstruction_Accept',
          choiceArgument: { extraArgs: EMPTY_EXTRA_ARGS },
        },
      },
    ],
  );
}

/**
 * A test-only sealer: files the treasurer's signed request and applies it as the treasury
 * (`Org_ApplySeal`), the MainNet-style path the sandbox allows. The DecMan sealer is covered by
 * the unit tests against a stub server.
 */
export function createTestSealer(
  world: Pick<CycleWorld, 'config' | 'ledger' | 'names'> & {
    parties: { treasury: string; agent: string };
  },
  drafts: DraftSource,
  /** Where the sealer writes its activity lines, as the DecMan sealer does. */
  activity?: ActivityLog,
): MandateSealer {
  const seals = new Map<string, SealStatus>();
  const { ledger, parties } = world;
  const prepareDeps = { config: world.config, ledger, drafts, names: world.names };
  return {
    async start(draftId, treasurer) {
      const prepared = await prepareSeal(prepareDeps, draftId, treasurer);
      const requestTx = await submitAs(
        ledger,
        [treasurer],
        [
          ledger.commands.createMandateSealRequest({
            treasury: parties.treasury,
            treasurer,
            agent: parties.agent,
            terms: prepared.terms,
            agentExecutes: true,
            summary: prepared.summary,
            summaryFingerprint: prepared.summaryFingerprint,
            requestedAt: new Date(),
          }),
        ],
      );
      const sealRequestCid =
        createdIn(requestTx, 'Mithra.Mandate:MandateSealRequest')[0]?.contractId ?? '';
      await submitAs(
        ledger,
        [parties.treasury],
        [
          ledger.commands.orgApplySeal(prepared.organization.contractId, {
            sealRequestCid,
            currentMandateCid: prepared.currentMandate?.contractId ?? null,
          }),
        ],
      );
      const sealId = randomUUID();
      // The same two activity lines, with the same text, as the DecMan sealer writes.
      await activity
        ?.record({
          actorParty: treasurer,
          kind: 'mandate.seal-requested',
          subject: sealId,
          text: sealRequestedText(prepared.description),
          link: '/app/settings',
        })
        .catch(() => undefined);
      const mandate = await ledger.reader.mandate();
      if (mandate) {
        await activity
          ?.record({
            actorParty: treasurer,
            kind: 'mandate.sealed',
            subject: sealId,
            text: sealedText(mandate.payload, world.config.asset.symbol),
            link: '/app/settings',
          })
          .catch(() => undefined);
      }
      const status: SealStatus = {
        sealId,
        state: 'sealed',
        treasurerSigned: true,
        nodeConfirmations: null,
        mandateVersion: prepared.nextVersion,
        error: null,
      };
      seals.set(status.sealId, status);
      return status;
    },
    status: (sealId) => Promise.resolve(seals.get(sealId) ?? failStatus(sealId)),
    advance: (sealId) => Promise.resolve(seals.get(sealId) ?? failStatus(sealId)),
    pending: () => Promise.resolve([]),
  };
}

function failStatus(sealId: string): SealStatus {
  return {
    sealId,
    state: 'failed',
    treasurerSigned: false,
    nodeConfirmations: null,
    mandateVersion: null,
    error: 'unknown seal',
  };
}

/** The cycle module with test settings: the test adapter and sealer, a 1 s countdown, no timers. */
export function makeModule(
  world: CycleWorld,
  overrides: Partial<CycleModuleDeps> = {},
): CycleModule {
  // The module reads drafts from the database, so a second drafts service over the same database
  // serves the test sealer.
  const drafts = createPolicyDrafts({
    config: world.config,
    db: world.db.db,
    ledger: world.ledger,
    names: world.names,
  });
  return createCycleModule({
    config: world.config,
    db: world.db.db,
    ledger: world.ledger,
    assets: world.adapter,
    names: world.names,
    activity: world.activity,
    bus: world.bus,
    holdCountdownSeconds: 1,
    timers: false,
    sealer: createTestSealer(world, drafts, world.activity),
    ...overrides,
  });
}

/**
 * A `Mandate_Propose` input for a cycle, built outside the engine (a second, stray proposal for
 * the same cycle). Amounts come from the same pure function the engine uses.
 */
export async function strayProposalInput(
  world: CycleWorld,
  options: { cycleId: string; total: string; recordDate: string; attempt: number },
): Promise<ProposalInput> {
  const register = await world.ledger.reader.register();
  if (!register) throw new Error('no register');
  const payouts = computeProRata(
    options.total,
    unitsAt(options.recordDate, register.payload.changes),
  );
  return {
    cycleId: options.cycleId,
    cycleLabel: `Cycle ${options.cycleId}`,
    attempt: options.attempt,
    total: options.total,
    recordDate: options.recordDate,
    trigger: 'TriggerManual',
    triggerDetail: 'Stray proposal made outside the engine',
    payouts,
    registerCid: register.contractId,
    inputFingerprints: [],
    checks: [],
    memo: 'stray',
    memoSource: 'template',
    modelFingerprints: [],
    seeded: false,
  };
}

export { isoDate, daysAgo };

/**
 * Submits `Mandate_AgentExecute` for a proposal directly on the ledger, bypassing the engine's
 * readiness checks, to show what the ledger itself refuses (L1, L3, L4).
 */
export async function directExecute(
  world: CycleWorld,
  proposal: Contract<Proposal>,
): Promise<Transaction> {
  const mandate = await world.ledger.reader.mandate();
  if (!mandate) throw new Error('no mandate');
  const holdings = await world.adapter.holdings(world.parties.treasury);
  const legs = (
    await Promise.all(
      proposal.payload.payouts.map((p) =>
        world.adapter.transferLeg({
          sender: world.parties.treasury,
          receiver: p.holder,
          amount: p.amount,
        }),
      ),
    )
  ).map((r) => r.leg);
  return world.ledger.client.submit({
    actAs: [world.parties.agent],
    readAs: [world.parties.treasury],
    commands: [
      world.ledger.commands.mandateAgentExecute(mandate.contractId, {
        proposalCid: proposal.contractId,
        legs,
        inputHoldingCids: holdings.map((h) => h.contractId),
        executeBefore: new Date(Date.now() + 60_000),
      }),
    ],
    shape: 'LEDGER_EFFECTS',
  });
}
