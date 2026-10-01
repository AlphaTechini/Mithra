import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { toDecimal, formatDecimal } from '@mithra/shared';
import Decimal from 'decimal.js';
import type { Config } from '../../src/config/env';
import type { DatabaseHandle } from '../../src/db';
import {
  choiceResults,
  createLedger,
  createdIn,
  type CheckResult,
  type DisclosedContract,
  type ExtraArgs,
  type Ledger,
  type LedgerCommand,
  type MandateTerms,
  type Payout,
  type ProposalInput,
  type TransferLeg,
  type Transaction,
} from '../../src/ledger';

export const SANDBOX_URL = process.env['LEDGER_JSON_API_URL'] ?? 'http://localhost:7575';
export const DATABASE_URL_TEST =
  process.env['DATABASE_URL_TEST'] ?? 'postgres://mithra:mithra@localhost:5432/mithra_test';

/** The sandbox has no authentication; its admin user is `participant_admin`. */
export const SANDBOX_USER = 'participant_admin';

// Template and interface ids of the test token registry (the mithra-tests DAR).
const TEST_PKG = '#mithra-tests:Mithra.Test.Registry';
export const TEST_HOLDING = `${TEST_PKG}:TestHolding`;
export const TEST_FACTORY = `${TEST_PKG}:TestTransferFactory`;
export const TEST_PREAPPROVAL = `${TEST_PKG}:TestPreapproval`;
export const TRANSFER_FACTORY_INTERFACE =
  '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory';
export const TRANSFER_INSTRUCTION_INTERFACE =
  '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction';
/** Key the test registry looks up in the choice context to complete a transfer in one step. */
export const PREAPPROVAL_KEY = 'mithra-test/preapproval';

export const PARTY_NAMES = [
  'registryAdmin',
  'treasury',
  'treasurer',
  'agent',
  'operator',
  'approver1',
  'approver2',
  'holderA',
  'holderB',
  'holderC',
  'auditor',
  'outsider',
] as const;
export type PartyName = (typeof PARTY_NAMES)[number];

/** Fails the test run with instructions when the sandbox is not up; integration tests need it. */
export async function requireSandbox(): Promise<void> {
  const reachable = await fetch(`${SANDBOX_URL}/v2/version`, {
    signal: AbortSignal.timeout(3000),
  }).then(
    (response) => response.ok,
    () => false,
  );
  if (!reachable) {
    throw new Error(
      `No Canton sandbox answers at ${SANDBOX_URL}. Start it with scripts/sandbox.sh start (or set LEDGER_JSON_API_URL), then run the integration tests again.`,
    );
  }
}

export function localnetConfig(
  parties: Record<PartyName, string>,
  overrides: Partial<Config> = {},
): Config {
  const base = {
    network: 'localnet' as const,
    host: '127.0.0.1',
    port: 0,
    webOrigin: 'http://localhost:5173',
    webDistDir: undefined,
    logLevel: 'silent' as const,
    databaseUrl: DATABASE_URL_TEST,
    sessionSecret: 'integration-test-session-secret-0123456789',
    llm: { baseUrl: 'http://localhost:1/v1', apiKey: 'unused', model: 'unused', timeoutMs: 1000 },
    ledger: {
      jsonApiUrl: SANDBOX_URL,
      userId: SANDBOX_USER,
      auth: { mode: 'none' as const },
      mithraPackage: '#mithra-v1',
      readAsTreasury: true,
    },
    parties: { treasury: parties.treasury, agent: parties.agent, operator: parties.operator },
    asset: { adminParty: parties.registryAdmin, id: 'CC', symbol: 'CC' },
    registryUrl: 'http://localhost:1/unused',
    localnet: {
      demoPassword: 'demo-password',
      demoParties: [
        { partyId: parties.treasurer, displayName: 'Treasurer' },
        { partyId: parties.approver1, displayName: 'Approver 1' },
        { partyId: parties.holderA, displayName: 'Holder A' },
        { partyId: parties.outsider, displayName: 'Newcomer' },
      ],
      nodes: [
        {
          id: 'a',
          name: 'Node A',
          operator: 'Op A',
          jsonApiUrl: SANDBOX_URL,
          decmanUrl: 'http://localhost:8081',
          autoConfirm: true,
        },
        {
          id: 'b',
          name: 'Node B',
          operator: 'Op B',
          jsonApiUrl: 'http://localhost:1',
          decmanUrl: 'http://localhost:8082',
          autoConfirm: true,
        },
        {
          id: 'c',
          name: 'Node C',
          operator: 'Op C',
          jsonApiUrl: 'http://localhost:1',
          decmanUrl: 'http://localhost:8083',
          autoConfirm: false,
        },
      ],
      decmanGovernanceThreshold: 2,
    },
  };
  return { ...base, ...overrides } as Config;
}

export function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function defaultTerms(
  asset: { admin: string; id: string },
  approvers: string[],
): MandateTerms {
  return {
    cap: '5000.0000000000',
    approvers,
    approvalThreshold: 2,
    asset,
    scheduleCron: '0 9 1 * *',
    scheduleTimezone: 'UTC',
    recordDateRule: 'last_day_of_previous_month',
    fixedAmount: null,
    deviationPct: '50.0000000000',
    trailingCycles: 3,
    unitChangePct: '25.0000000000',
    unitChangeWindowDays: 30,
    feeBuffer: '1.0000000000',
  };
}

/**
 * The pro-rata rule of docs/ledger-model.md, with decimal.js: sorted by party id, shares rounded
 * down to 10 places, the residual added to the holder with the most units (first on ties).
 */
export function proRata(total: string, holdings: { holder: string; units: number }[]): Payout[] {
  const sorted = [...holdings].sort((a, b) =>
    a.holder < b.holder ? -1 : a.holder > b.holder ? 1 : 0,
  );
  const totalUnits = sorted.reduce((sum, h) => sum + h.units, 0);
  const totalDec = toDecimal(total);
  const shares = sorted.map((h) =>
    totalDec.mul(h.units).div(totalUnits).toDecimalPlaces(10, Decimal.ROUND_DOWN),
  );
  // Sums start from a zero of the same Decimal class as `total`, which has the working precision.
  const residual = totalDec.minus(shares.reduce((a, b) => a.plus(b), totalDec.minus(totalDec)));
  const maxUnits = Math.max(...sorted.map((h) => h.units));
  const firstMax = sorted.findIndex((h) => h.units === maxUnits);
  return sorted.map((h, i) => ({
    holder: h.holder,
    units: h.units,
    amount: formatDecimal(
      i === firstMax
        ? (shares[i] ?? residual.mul(0)).plus(residual)
        : (shares[i] ?? residual.mul(0)),
    ),
  }));
}

export function passingCheck(code: string, label: string): CheckResult {
  return {
    code,
    label,
    passed: true,
    blocking: true,
    actual: 'ok',
    limit: 'ok',
    source: 'deterministic',
  };
}

export interface World {
  parties: Record<PartyName, string>;
  config: Config;
  ledger: Ledger;
  /** Ids of the contracts created by `createWorld`. */
  ids: {
    factoryCid: string;
    charterCid: string;
    orgCid: string;
    registerCid: string;
    mandateCid: string;
    preapprovals: Record<string, string>;
  };
  /** Units issued by `createWorld`, in order. */
  units: { holder: string; units: number; effectiveDate: string }[];
  terms: MandateTerms;
}

/** Extra arguments for a registry choice with an empty context. */
export const EMPTY_EXTRA_ARGS: ExtraArgs = { context: { values: {} }, meta: { values: {} } };

/** The leg for one holder: one-step with a preapproval, otherwise a pending transfer. */
export function testLeg(
  factoryCid: string,
  holder: string,
  preapprovalCid: string | undefined,
): TransferLeg {
  return {
    holder,
    factoryCid,
    extraArgs: preapprovalCid
      ? {
          context: {
            values: { [PREAPPROVAL_KEY]: { tag: 'AV_ContractId', value: preapprovalCid } },
          },
          meta: { values: {} },
        }
      : EMPTY_EXTRA_ARGS,
  };
}

/** A helper to submit as one party (with read-as) and read choice results. */
export function submitter(ledger: Ledger) {
  return {
    async as(
      actAs: string[],
      commands: LedgerCommand[],
      options: { readAs?: string[]; disclosed?: DisclosedContract[] } = {},
    ): Promise<Transaction> {
      return ledger.client.submit({
        actAs,
        ...(options.readAs ? { readAs: options.readAs } : {}),
        commands,
        ...(options.disclosed ? { disclosedContracts: options.disclosed } : {}),
        shape: 'LEDGER_EFFECTS',
      });
    },
  };
}

/**
 * Allocates parties and builds a complete organization on the sandbox: a test token registry
 * with funds for the treasury, a charter, an organization, a sealed Mandate and three holders with
 * units (A 100, B 300, C 600).
 */
export async function createWorld(): Promise<World> {
  const suffix = randomBytes(3).toString('hex');
  const parties = {} as Record<PartyName, string>;
  for (const name of PARTY_NAMES) {
    parties[name] = await adminLedger.client.allocateParty(`${name}${suffix}`);
  }
  const config = localnetConfig(parties);
  const ledger = createLedger(config);
  const { commands } = ledger;
  const as = submitter(ledger);
  const asset = { admin: parties.registryAdmin, id: 'CC' };

  // Test token registry: funds for the treasury, a factory, a preapproval for every holder.
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
  const preapprovals: Record<string, string> = {};
  for (const holder of [parties.holderA, parties.holderB, parties.holderC]) {
    const tx = await as.as(
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

  // Charter (treasury), organization (treasurer), sealed Mandate (treasury), units (treasurer).
  const terms = defaultTerms(asset, [parties.approver1, parties.approver2]);
  const charterTx = await as.as(
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
  const orgTx = await as.as(
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
  const sealTx = await as.as(
    [parties.treasurer],
    [
      commands.createMandateSealRequest({
        treasury: parties.treasury,
        treasurer: parties.treasurer,
        agent: parties.agent,
        terms,
        agentExecutes: true,
        summary: 'Test terms',
        summaryFingerprint: '00',
        requestedAt: new Date(),
      }),
    ],
  );
  const sealRequestCid =
    createdIn(sealTx, 'Mithra.Mandate:MandateSealRequest')[0]?.contractId ?? '';
  const applyTx = await as.as(
    [parties.treasury],
    [commands.orgApplySeal(org0, { sealRequestCid, currentMandateCid: null })],
  );
  const { orgCid, mandateCid } = choiceResults.orgApplySeal(applyTx);

  const units = [
    { holder: parties.holderA, units: 100, effectiveDate: isoDate(daysAgo(60)) },
    { holder: parties.holderB, units: 300, effectiveDate: isoDate(daysAgo(60)) },
    { holder: parties.holderC, units: 600, effectiveDate: isoDate(daysAgo(40)) },
  ];
  let registerCid = register0;
  for (const u of units) {
    const tx = await as.as(
      [parties.treasurer],
      [
        commands.orgIssueUnits(orgCid, {
          registerCid,
          holder: u.holder,
          units: u.units,
          effectiveDate: u.effectiveDate,
          seeded: false,
        }),
      ],
    );
    registerCid = choiceResults.orgIssueUnits(tx).registerCid;
  }

  return {
    parties,
    config,
    ledger,
    ids: { factoryCid, charterCid, orgCid, registerCid, mandateCid, preapprovals },
    units,
    terms,
  };
}

/** A ledger client for allocating parties, before the parties exist. */
const adminLedger: Ledger = createLedger({
  ledger: {
    jsonApiUrl: SANDBOX_URL,
    userId: SANDBOX_USER,
    auth: { mode: 'none' },
    mithraPackage: '#mithra-v1',
    readAsTreasury: false,
  },
  parties: { treasury: 'unused', agent: 'unused', operator: 'unused' },
});

/** A Mandate_Propose input with the correct pro-rata payouts for the world's units. */
export function proposalInput(
  world: World,
  options: {
    cycleId: string;
    total: string;
    attempt?: number;
    checks?: CheckResult[];
    payouts?: Payout[];
  },
): ProposalInput {
  const holdings = world.units.map((u) => ({ holder: u.holder, units: u.units }));
  return {
    cycleId: options.cycleId,
    cycleLabel: `Cycle ${options.cycleId}`,
    attempt: options.attempt ?? 1,
    total: options.total,
    recordDate: isoDate(daysAgo(1)),
    trigger: 'TriggerSchedule',
    triggerDetail: 'Monthly schedule 0 9 1 * *',
    payouts: options.payouts ?? proRata(options.total, holdings),
    registerCid: world.ids.registerCid,
    inputFingerprints: [{ label: 'register', sha256: 'ab12' }],
    checks: options.checks ?? [passingCheck('cap', 'Within the auto-execute cap')],
    memo: "Distribute the month's income pro rata.",
    memoSource: 'template',
    modelFingerprints: [],
    seeded: false,
  };
}

export function loadVectors(): {
  name: string;
  total: string;
  holdings: { holder: string; units: number }[];
  expected?: { holder: string; amount: string }[];
  expectError?: boolean;
  recordDate?: string;
  changes?: unknown[];
}[] {
  const url = new URL('../../../../daml/test-vectors/prorata.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as ReturnType<typeof loadVectors>;
}

/** Empties the test database, so migrations are applied to a blank one. */
export async function resetDatabase(handle: DatabaseHandle): Promise<void> {
  await handle.pool.query('drop schema if exists drizzle cascade');
  await handle.pool.query('drop schema if exists public cascade');
  await handle.pool.query('create schema public');
}
