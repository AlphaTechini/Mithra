import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEMO_CYCLES,
  DEMO_HOLDERS,
  FUND_NAME,
  runSeed,
  type StepResult,
} from '../../../../scripts/seed/steps';
import { bootFullStack, type FullStack } from '../e2e/server';
import { requireSandbox } from './helpers';

/**
 * The seeding script's steps (scripts/seed/steps.ts) against the full-stack test server's world
 * (what `pnpm seed:localnet --sandbox` runs): they create real, tagged history once, and a second
 * run changes nothing.
 */

const DATABASE_URL =
  process.env['DATABASE_URL_TEST_MW'] ?? 'postgres://mithra:mithra@localhost:5432/mithra_test_mw';

describe('seeding: demo history on the ledger, tagged as seeded, idempotent', () => {
  let stack: FullStack;
  const lines: string[][] = [[], []];

  async function seed(round: 0 | 1): Promise<StepResult[]> {
    return runSeed({
      backend: stack.backend,
      print: (line) => lines[round]?.push(line),
      pollMs: 200,
    });
  }

  beforeAll(async () => {
    await requireSandbox();
    // 5,000 test CC to start with, so the funding step has something to do.
    stack = await bootFullStack({
      databaseUrl: DATABASE_URL,
      initialFunds: '5000',
      holdCountdownSeconds: 1,
      webDistDir: null,
      logLevel: 'silent',
    });
  });

  afterAll(async () => {
    await stack?.close();
  });

  it('creates the organization, the Mandate, units, funds and two executed cycles', async () => {
    const results = await seed(0);
    expect(results.map((r) => r.step)).toEqual([
      'Organization',
      'Mandate',
      ...DEMO_HOLDERS.map((h) => `Units ${h.name}`),
      'Treasury funds',
      ...DEMO_CYCLES.map((c) => `Cycle ${c.cycleId}`),
    ]);
    expect(results.every((r) => r.outcome === 'done')).toBe(true);
    // One line per step.
    expect(lines[0]).toHaveLength(results.length);

    const { ledger, parties } = stack;
    const organization = await ledger.reader.organization();
    expect(organization?.payload).toMatchObject({ name: FUND_NAME, approvalThreshold: 2 });
    expect(organization?.payload.approvers).toEqual([
      parties.approver1,
      parties.approver2,
      parties.approver3,
    ]);
    const mandate = await ledger.reader.mandate();
    expect(mandate?.payload.terms).toMatchObject({
      cap: '5000.0000000000',
      approvalThreshold: 2,
      scheduleCron: '0 9 1 * *',
      deviationPct: '50.0000000000',
      trailingCycles: 3,
      unitChangePct: '100.0000000000',
      unitChangeWindowDays: 3,
      feeBuffer: '1.0000000000',
    });

    // Units: the four holders, effective 2026-05-01, tagged as seeded.
    const changes = (await ledger.reader.register())?.payload.changes ?? [];
    expect(changes.map((c) => [c.holder, c.delta, c.effectiveDate, c.seeded])).toEqual(
      [
        [parties.holderA, 100],
        [parties.holderB, 300],
        [parties.holderC, 600],
        [parties.holderD, 1000],
      ].map(([holder, units]) => [holder, units, '2026-05-01', true]),
    );

    // Two executed cycles, seeded all the way down to the payments.
    const cycles = await stack.backend.cycle.cycles.listCycles();
    expect(cycles.map((c) => [c.cycleId, c.total, c.trigger, c.seeded]).sort()).toEqual([
      ['2026-07', '400.0000000000', 'manual', true],
      ['2026-08', '420.0000000000', 'manual', true],
    ]);
    const payments = await ledger.reader.payments();
    expect(payments).toHaveLength(8);
    expect(payments.every((p) => p.payload.seeded)).toBe(true);
    const outcomes = await ledger.reader.outcomes();
    expect(outcomes.every((o) => o.payload.seeded && o.payload.kind === 'Executed')).toBe(true);

    // 5,000 + 20,000 - 400 - 420.
    expect(await stack.backend.asset.balance(parties.treasury)).toMatch(/^24180/);
    const activity = await stack.backend.activity.list(50);
    expect(activity.filter((a) => a.seeded).map((a) => a.kind)).toEqual(
      expect.arrayContaining(['org.created', 'units.issued']),
    );
  });

  it('a second run finds everything done and changes nothing', async () => {
    const before = {
      contracts: await countContracts(stack),
      activity: (await stack.backend.activity.list(500)).length,
    };
    const results = await seed(1);
    expect(results.every((r) => r.outcome === 'skipped')).toBe(true);
    expect(lines[1]).toHaveLength(results.length);
    for (const line of lines[1] ?? []) expect(line).toContain('already done');
    expect(await countContracts(stack)).toEqual(before.contracts);
    expect((await stack.backend.activity.list(500)).length).toBe(before.activity);
  });
});

async function countContracts(stack: FullStack): Promise<Record<string, number>> {
  const { reader } = stack.ledger;
  return {
    proposals: (await reader.proposals()).length,
    decisions: (await reader.decisionRecords()).length,
    outcomes: (await reader.outcomes()).length,
    payments: (await reader.payments()).length,
    fundUnits: (await reader.fundUnits()).length,
    register: (await reader.register())?.payload.changes.length ?? 0,
  };
}
