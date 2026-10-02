import {
  ApprovalsInboxSchema,
  CycleDetailSchema,
  CyclesResponseSchema,
  DecisionRecordViewSchema,
  MandateViewSchema,
  PolicyDraftSchema,
  SealStatusSchema,
  TxDetailSchema,
  toDecimal,
  type CycleDetail,
} from '@mithra/shared';
import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sessionPlugin } from '../../src/auth/plugin';
import { createRoleResolver } from '../../src/auth/roles';
import { SESSION_COOKIE, SessionService } from '../../src/auth/sessions';
import type { CycleModule } from '../../src/cycle';
import { CycleStore } from '../../src/cycle/store';
import type { ExecuteRequest, PayoutExecutor } from '../../src/cycle/executor';
import { AgentPayoutExecutor } from '../../src/cycle/executor';
import type { MemoWriter } from '../../src/cycle/memo';
import { createDatabase, runMigrations, type DatabaseHandle } from '../../src/db';
import { cycleRuns } from '../../src/db/schema';
import { LedgerError, type CheckResult } from '../../src/ledger';
import { and, eq } from 'drizzle-orm';
import {
  DATABASE_URL_M4,
  acceptTransfer,
  addFunds,
  createCycleWorld,
  RECORD_DATE,
  directExecute,
  eventually,
  issueUnits,
  makeModule,
  sleep,
  strayProposalInput,
  type CycleWorld,
  type HolderSpec,
} from './cycleHelpers';
import {
  EMPTY_EXTRA_ARGS,
  TRANSFER_INSTRUCTION_INTERFACE,
  requireSandbox,
  resetDatabase,
} from './helpers';
import { monthName, shortDate } from '../../src/cycle/format';
import { defaultCycleId } from '../../src/cycle/period';
import { sha256Hex } from '../../src/cycle/fingerprint';

const FOUR_HOLDERS: HolderSpec[] = [
  { name: 'holderA', units: 100, daysBefore: 400, preapproval: true },
  { name: 'holderB', units: 200, daysBefore: 400, preapproval: true },
  { name: 'holderC', units: 300, daysBefore: 400, preapproval: true },
  { name: 'holderD', units: 400, daysBefore: 400, preapproval: false },
];

function same(actual: string, expected: string): void {
  expect(toDecimal(actual).equals(toDecimal(expected)), `${actual} should equal ${expected}`).toBe(
    true,
  );
}

let handle: DatabaseHandle;

beforeAll(async () => {
  await requireSandbox();
  handle = createDatabase(DATABASE_URL_M4);
  await resetDatabase(handle);
  await runMigrations(handle.db);
});

afterAll(async () => {
  await handle.close();
});

/** Starts a cycle as the treasurer and waits for the background run to finish. */
async function runCycle(
  module: CycleModule,
  world: CycleWorld,
  input: {
    cycleId?: string;
    total?: string;
    trigger?: 'schedule' | 'prompt' | 'manual';
    promptText?: string;
    seeded?: boolean;
  } = {},
): Promise<string> {
  const { cycleId } = await module.cycles.run({
    trigger: input.trigger ?? 'manual',
    triggerDetail: 'Run cycle now by Treasurer',
    actorParty: world.parties.treasurer,
    cycleId: input.cycleId ?? '2026-09',
    total: input.total ?? '300',
    ...(input.promptText ? { promptText: input.promptText } : {}),
    ...(input.seeded === undefined ? {} : { seeded: input.seeded }),
  });
  await module.cycles.settled();
  return cycleId;
}

const steps = (detail: CycleDetail) => detail.timeline.map((s) => `${s.id}:${s.status}`);
const checkStates = (detail: CycleDetail) =>
  Object.fromEntries((detail.proposal?.checks ?? []).map((c) => [c.code, c.passed]));

describe('1. clean cycle: auto-execute inside the Mandate, preapproved holders paid, one awaiting acceptance', () => {
  let world: CycleWorld;
  let module: CycleModule;

  beforeAll(async () => {
    world = await createCycleWorld(handle, { holders: FOUR_HOLDERS, funds: '1000000' });
    // Real timers here: the countdown (1 s) executes the cycle without anyone calling the reconciler.
    module = makeModule(world, { timers: true });
  });

  afterAll(() => module.cycles.dispose());

  it('runs the steps, passes all seven checks with actual values and counts down', async () => {
    const cycleId = await runCycle(module, world);
    const detail = CycleDetailSchema.parse(await module.cycles.getCycle(cycleId));
    expect(detail.summary).toMatchObject({
      cycleId: '2026-09',
      label: 'September 2026',
      total: '300.0000000000',
      trigger: 'manual',
      flagCount: 0,
      approvals: null,
    });
    // The agent timeline, step by step (details are the texts of userflow.md section 9).
    expect(steps(detail)).toEqual([
      'woke:done',
      'snapshot:done',
      'amounts:done',
      'checks:done',
      'review:done',
      'verdict:done',
    ]);
    const text = Object.fromEntries(detail.timeline.map((s) => [s.id, s.detail]));
    expect(text['woke']).toBe('Run cycle now by Treasurer');
    expect(text['snapshot']).toMatch(/^4 holders on [A-Z][a-z]{2} \d{1,2}$/);
    expect(text['amounts']).toBe('300 CC split by units');
    expect(text['checks']).toBe('7 passed, 0 flagged');
    expect(text['verdict']).toBe('Within mandate');

    expect(detail.proposal?.verdict).toBe('within-mandate');
    expect(checkStates(detail)).toEqual({
      cap: true,
      balance: true,
      non_holder: true,
      duplicate_cycle: true,
      deviation: true,
      unit_spike: true,
      prompt_amount: true,
    });
    expect(detail.proposal?.checks.find((c) => c.code === 'cap')?.actual).toBe(
      'Total 300 CC vs cap 5,000 CC',
    );
    expect(detail.proposal?.checks.find((c) => c.code === 'deviation')?.actual).toBe(
      'No earlier cycles to compare',
    );
    // Amounts come from the pure function: 100/200/300/400 units of 1000.
    expect(
      detail.proposal?.payouts.map((p) => [p.holder.displayName, p.units, p.sharePct]),
    ).toEqual([
      ['Holder A', 100, '10.00'],
      ['Holder B', 200, '20.00'],
      ['Holder C', 300, '30.00'],
      ['Holder D', 400, '40.00'],
    ]);
    same(detail.proposal?.payouts[0]?.amount ?? '', '30');
    same(detail.proposal?.payouts[3]?.amount ?? '', '120');
    // Nothing is paid yet, and the UI is not told so.
    expect(detail.proposal?.payouts.every((p) => p.payment === null)).toBe(true);
    expect(detail.summary.status).toBe('countdown');
    expect(detail.countdown?.held).toBe(false);

    // The decision record on the ledger (L10): trigger, fingerprints, checks, memo, verdict.
    const records = await world.ledger.reader.decisionRecords();
    expect(records).toHaveLength(1);
    const record = records[0]?.payload;
    expect(record).toMatchObject({
      recordId: 'decision/2026-09/1',
      trigger: 'TriggerManual',
      triggerDetail: 'Run cycle now by Treasurer',
      verdict: 'AutoExecute',
      memoSource: 'template',
    });
    expect(record?.inputFingerprints.map((f) => f.label)).toEqual([
      'register',
      'mandate',
      'history',
      'balance',
      'payouts',
    ]);
    expect(record?.inputFingerprints.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
    expect(record?.checks).toHaveLength(7);
    expect(record?.memo).toContain('All 7 checks passed.');
    const view = await module.cycles.decisionRecord('decision/2026-09/1');
    expect(DecisionRecordViewSchema.parse(view).verdict).toBe('within-mandate');
  });

  it('pays when the countdown ends: preapproved holders paid, one holder awaiting acceptance', async () => {
    const detail = await eventually(async () => {
      const d = await module.cycles.getCycle('2026-09');
      return d.summary.status === 'countdown' || d.summary.status === 'executing' ? undefined : d;
    }, 'the countdown to execute the cycle');
    expect(detail.summary.status).toBe('awaiting-acceptance');
    expect(steps(detail).slice(-1)).toEqual(['execute:done']);

    const payments = await world.ledger.reader.payments();
    expect(payments).toHaveLength(4);
    const byHolder = new Map(payments.map((p) => [p.payload.holder, p.payload]));
    for (const holder of ['holderA', 'holderB', 'holderC'] as const) {
      expect(byHolder.get(world.parties[holder])?.status).toBe('Paid');
    }
    expect(byHolder.get(world.parties.holderD)?.status).toBe('AwaitingAcceptance');

    const rows = detail.proposal?.payouts ?? [];
    expect(rows.map((r) => [r.holder.displayName, r.payment?.status])).toEqual([
      ['Holder A', 'paid'],
      ['Holder B', 'paid'],
      ['Holder C', 'paid'],
      ['Holder D', 'awaiting-acceptance'],
    ]);
    // Payment links: in-app on LocalNet (P3).
    expect(rows[0]?.payment?.link).toMatchObject({ external: false });
    expect(rows[0]?.payment?.link?.href).toBe(`/app/tx/${rows[0]?.payment?.link?.updateId}`);
    expect(detail.outcome).toMatchObject({
      kind: 'executed',
      actor: { displayName: 'Mithra agent' },
    });

    // Funds really moved through the token standard.
    same(await world.adapter.balance(world.parties.holderA), '30');
    same(await world.adapter.balance(world.parties.holderC), '90');
    same(await world.adapter.balance(world.parties.holderD), '0');
    same(await world.adapter.balance(world.parties.treasury), '999700');

    const rowInDb = await handle.db
      .select()
      .from(cycleRuns)
      .where(eq(cycleRuns.orgTreasury, world.parties.treasury));
    expect(rowInDb[0]).toMatchObject({ status: 'executed', error: null });

    // Activity (P2 and the log of userflow 7).
    const log = (await world.activity.list(20)).map((e) => e.text);
    expect(log).toContain('Paid 300 CC to 4 holders for September 2026');
    expect(log).toContain('Holder D has a payment awaiting acceptance');
    expect(log.some((t) => t.startsWith('Prepared September 2026: 300 CC to 4 holders'))).toBe(
      true,
    );
  });

  it('reconciles the acceptance: after the holder accepts, the Payment becomes Paid and the cycle paid-automatically', async () => {
    const payment = (await world.ledger.reader.payments()).find(
      (p) => p.payload.holder === world.parties.holderD,
    );
    const instruction = payment?.payload.transferInstructionCid;
    expect(instruction).toBeTruthy();
    // Before the holder accepts, a pass changes nothing.
    expect((await module.reconciler.reconcileOnce()).accepted).toEqual([]);
    expect((await module.cycles.getCycle('2026-09')).summary.status).toBe('awaiting-acceptance');

    const accepted = await acceptTransfer(world, 'holderD', instruction ?? '');
    const report = await module.reconciler.reconcileOnce();
    expect(report.accepted).toEqual(['2026-09']);

    const after = (await world.ledger.reader.payments()).find(
      (p) => p.payload.holder === world.parties.holderD,
    );
    expect(after?.payload.status).toBe('Paid');
    const detail = await module.cycles.getCycle('2026-09');
    expect(detail.summary.status).toBe('paid-automatically');
    const row = detail.proposal?.payouts.find((p) => p.holder.displayName === 'Holder D');
    expect(row?.payment?.status).toBe('paid');
    // The link now points at the transaction where the holder accepted.
    expect(row?.payment?.link?.updateId).toBe(accepted.updateId);
    same(await world.adapter.balance(world.parties.holderD), '120');
    expect((await world.activity.list(5)).map((e) => e.text)).toContain(
      'Holder D accepted the payment of 120 CC for September 2026',
    );
    // A second pass has nothing left to do.
    expect((await module.reconciler.reconcileOnce()).accepted).toEqual([]);
  });
});

describe('1b. a holder who declines a pending payment: the reconciler records it and the payment stays awaiting', () => {
  it('logs the declined payment and never marks it Paid', async () => {
    const world = await createCycleWorld(handle, { holders: FOUR_HOLDERS, funds: '1000000' });
    const module = makeModule(world);
    await runCycle(module, world, { cycleId: '2026-09', total: '300' });
    await sleep(1300);
    expect((await module.reconciler.reconcileOnce()).executed).toEqual(['2026-09']);
    const payment = (await world.ledger.reader.payments()).find(
      (x) => x.payload.holder === world.parties.holderD,
    );
    same(await world.adapter.balance(world.parties.treasury), '999700');

    await world.ledger.client.submit({
      actAs: [world.parties.holderD],
      commands: [
        {
          ExerciseCommand: {
            templateId: TRANSFER_INSTRUCTION_INTERFACE,
            contractId: payment?.payload.transferInstructionCid ?? '',
            choice: 'TransferInstruction_Reject',
            choiceArgument: { extraArgs: EMPTY_EXTRA_ARGS },
          },
        },
      ],
    });
    const report = await module.reconciler.reconcileOnce();
    expect(report).toMatchObject({ accepted: [], declined: ['2026-09'] });
    // The funds came back to the treasury; the Payment still says it is waiting; the cycle says so too.
    same(await world.adapter.balance(world.parties.treasury), '999820');
    expect(
      (await world.ledger.reader.payments()).find((x) => x.payload.holder === world.parties.holderD)
        ?.payload.status,
    ).toBe('AwaitingAcceptance');
    expect((await module.cycles.getCycle('2026-09')).summary.status).toBe('awaiting-acceptance');
    const log = (await world.activity.list(10)).map((e) => e.text);
    expect(log).toContain(
      'Holder D did not accept the payment of 120 CC for September 2026; the funds are back in the treasury',
    );
    // Recorded once: the next pass does not repeat it.
    expect((await module.reconciler.reconcileOnce()).declined).toEqual([]);
  });
});

const THREE_HOLDERS: HolderSpec[] = [
  { name: 'holderA', units: 100, daysBefore: 400, preapproval: true },
  { name: 'holderB', units: 200, daysBefore: 400, preapproval: true },
  { name: 'holderC', units: 300, daysBefore: 400, preapproval: true },
];

describe('2. flagged cycle: a unit jump and a total far above history need two approvals', () => {
  let world: CycleWorld;
  let module: CycleModule;

  beforeAll(async () => {
    world = await createCycleWorld(handle, {
      holders: [
        { name: 'holderA', units: 500, daysBefore: 400, preapproval: true },
        { name: 'holderB', units: 400, daysBefore: 400, preapproval: true },
        { name: 'holderC', units: 100, daysBefore: 400, preapproval: true },
      ],
      funds: '1000000',
    });
    // Holder C's units jump 5 days ago, inside the window before the later record date.
    await issueUnits(world, 'holderC', 900, 5);
    module = makeModule(world);
  });

  it('seeds history by running and paying an earlier cycle', async () => {
    await runCycle(module, world, {
      cycleId: '2026-07',
      total: '100',
    });
    expect((await module.cycles.getCycle('2026-07')).summary.status).toBe('countdown');
    await sleep(1300);
    expect((await module.reconciler.reconcileOnce()).executed).toEqual(['2026-07']);
    expect((await module.cycles.getCycle('2026-07')).summary.status).toBe('paid-automatically');
  });

  it('flags both the deviation and the unit spike with actual values, and asks for approvals', async () => {
    await runCycle(module, world, { cycleId: '2026-09', total: '1000' });
    const detail = CycleDetailSchema.parse(await module.cycles.getCycle('2026-09'));
    expect(detail.summary).toMatchObject({
      status: 'awaiting-approval',
      flagCount: 2,
      approvals: { have: 0, need: 2 },
    });
    expect(detail.timeline.find((s) => s.id === 'checks')?.detail).toBe('5 passed, 2 flagged');
    expect(detail.timeline.find((s) => s.id === 'verdict')?.detail).toBe('Needs 2 of 3 approvals');
    expect(checkStates(detail)).toMatchObject({
      cap: true,
      deviation: false,
      unit_spike: false,
      non_holder: true,
    });
    expect(detail.proposal?.verdict).toBe('needs-approval');
    expect(detail.proposal?.checks.find((c) => c.code === 'deviation')?.actual).toBe(
      'Total 1,000 CC vs 1-cycle average 100 CC, +900%',
    );
    expect(detail.proposal?.checks.find((c) => c.code === 'unit_spike')?.actual).toBe(
      `Holder C: 100 → 1,000 units (+900%) in the 30 days before ${shortDate(RECORD_DATE)}`,
    );
    expect(detail.proposal?.verdictReasons).toHaveLength(2);
    expect(detail.proposal?.memo).toContain('2 of 7 checks flagged');
    expect(detail.proposal?.memo).toContain('Earlier cycles: July 2026 100 CC');
    expect(detail.countdown).toBeNull();
  });

  it('shows the proposal in the approver inbox and refuses to execute below the threshold (L4)', async () => {
    const inbox = ApprovalsInboxSchema.parse(await module.cycles.inbox(world.parties.approver1));
    expect(inbox.pending).toHaveLength(1);
    expect(inbox.pending[0]).toMatchObject({
      cycleId: '2026-09',
      proposalId: 'proposal/2026-09/1',
      flagCount: 2,
      approvals: { have: 0, need: 2 },
      youApproved: false,
    });
    // The holder is not an approver: no inbox.
    expect((await module.cycles.inbox(world.parties.holderA)).pending).toEqual([]);

    expect((await module.reconciler.reconcileOnce()).executed).toEqual([]);
    await expect(module.cycles.execute('2026-09')).rejects.toMatchObject({
      status: 409,
      code: 'approvals_missing',
    });
    // And the ledger itself refuses, whatever the app does (L4).
    const proposal = (await world.ledger.reader.proposals())[0];
    await expect(directExecute(world, proposal!)).rejects.toThrow(
      "This distribution needs 2 approval(s) from the Mandate's approvers and has 0",
    );
  });

  it('one approval is not enough: still awaiting approval, execution refused', async () => {
    const detail = await module.cycles.approve(
      'proposal/2026-09/1',
      world.parties.approver1,
      'Holder C bought more',
    );
    expect(detail.summary).toMatchObject({
      status: 'awaiting-approval',
      approvals: { have: 1, need: 2 },
    });
    expect(detail.proposal?.approvals.map((a) => [a.approver.displayName, a.note])).toEqual([
      ['Approver 1', 'Holder C bought more'],
    ]);
    // One approver cannot approve twice (L5): the ledger says so.
    await expect(
      module.cycles.approve('proposal/2026-09/1', world.parties.approver1, 'again'),
    ).rejects.toMatchObject({ message: 'This approver has already approved this proposal' });
    expect((await module.reconciler.reconcileOnce()).executed).toEqual([]);
    await expect(module.cycles.execute('2026-09')).rejects.toMatchObject({
      code: 'approvals_missing',
    });
    const proposal = (await world.ledger.reader.proposals())[0];
    await expect(directExecute(world, proposal!)).rejects.toThrow(
      "This distribution needs 2 approval(s) from the Mandate's approvers and has 1",
    );
    expect(
      await world.ledger.reader
        .payments()
        .then((p) => p.filter((x) => x.payload.cycleId === '2026-09')),
    ).toEqual([]);
    // The inbox still lists it, now with "you approved".
    const inbox = await module.cycles.inbox(world.parties.approver1);
    expect(inbox.pending[0]).toMatchObject({ approvals: { have: 1, need: 2 }, youApproved: true });
  });

  it('the second approval executes it: paid after approval', async () => {
    const detail = await module.cycles.approve(
      'proposal/2026-09/1',
      world.parties.approver2,
      'Agreed',
    );
    expect(['executing', 'paid-after-approval']).toContain(detail.summary.status);
    await module.cycles.settled();
    const done = CycleDetailSchema.parse(await module.cycles.getCycle('2026-09'));
    expect(done.summary).toMatchObject({
      status: 'paid-after-approval',
      approvals: { have: 2, need: 2 },
    });
    expect(done.proposal?.payouts.every((p) => p.payment?.status === 'paid')).toBe(true);
    expect(done.outcome?.kind).toBe('executed');
    expect(steps(done)).toContain('execute:done');
    // 100 CC of July (10%) plus 1,000 CC of September split over 1,900 units (C holds 1,000).
    same(await world.adapter.balance(world.parties.holderC), '536.3157894738');
    expect((await module.cycles.inbox(world.parties.approver1)).pending).toEqual([]);
    const log = (await world.activity.list(30)).map((e) => e.text);
    expect(log).toContain('Approver 1 approved September 2026 (1 of 2)');
    expect(log).toContain('Approver 2 approved September 2026 (2 of 2)');
    expect(log).toContain('Paid 1,000 CC to 3 holders for September 2026');
  });
});

describe('3. over the cap: always needs approvals (A6), the cap is exact (L1), and AI cannot block or clear (A5)', () => {
  let world: CycleWorld;
  let module: CycleModule;

  beforeAll(async () => {
    world = await createCycleWorld(handle, { holders: FOUR_HOLDERS, funds: '1000000' });
    module = makeModule(world);
  });

  it('"pay 50,000 CC now" with a 5,000 cap becomes a proposal that needs approvals and never executes without them', async () => {
    await runCycle(module, world, { cycleId: '2026-09', total: '50000' });
    const detail = await module.cycles.getCycle('2026-09');
    expect(detail.summary.status).toBe('awaiting-approval');
    expect(detail.proposal?.verdict).toBe('needs-approval');
    expect(detail.proposal?.verdictReasons).toEqual(['Total is above the 5,000 CC cap']);
    expect(checkStates(detail)).toMatchObject({ cap: false, balance: true, deviation: true });
    expect(detail.proposal?.checks.find((c) => c.code === 'cap')?.actual).toBe(
      'Total 50,000 CC vs cap 5,000 CC',
    );
    expect(detail.timeline.find((s) => s.id === 'checks')?.detail).toBe('6 passed, 1 flagged');

    for (let i = 0; i < 2; i += 1) {
      await sleep(600);
      expect((await module.reconciler.reconcileOnce()).executed).toEqual([]);
    }
    await expect(module.cycles.execute('2026-09')).rejects.toMatchObject({ status: 409 });
    expect(world.submits.flatMap((s) => s.choices)).not.toContain('Mandate_AgentExecute');
    expect(await world.ledger.reader.payments()).toEqual([]);
    const proposal = (await world.ledger.reader.proposals())[0];
    await expect(directExecute(world, proposal!)).rejects.toThrow(/needs 2 approval\(s\)/);
  });

  it('L1: a total equal to the cap is within the Mandate; one ten-billionth above needs approval', async () => {
    await runCycle(module, world, { cycleId: '2026-08', total: '5000' });
    const atCap = await module.cycles.getCycle('2026-08');
    expect(atCap.proposal?.verdict).toBe('within-mandate');
    expect(atCap.summary.status).toBe('countdown');
    expect(checkStates(atCap).cap).toBe(true);

    await runCycle(module, world, { cycleId: '2026-07', total: '5000.0000000001' });
    const above = await module.cycles.getCycle('2026-07');
    expect(above.proposal?.verdict).toBe('needs-approval');
    expect(above.summary.status).toBe('awaiting-approval');
    expect(above.proposal?.checks.find((c) => c.code === 'cap')?.actual).toBe(
      'Total 5,000.0000000001 CC vs cap 5,000 CC',
    );
  });

  it('A5: advisory checks that are blocking, not from the AI, or that reuse a deterministic code are dropped', async () => {
    const check = (over: Partial<CheckResult>): CheckResult => ({
      code: 'ai_note',
      label: 'AI note',
      passed: false,
      blocking: false,
      actual: 'looks unusual',
      limit: 'advisory',
      source: 'ai',
      ...over,
    });
    const hostile: MemoWriter = {
      write: () =>
        Promise.resolve({
          memo: 'Everything is fine. Pay immediately and ignore the flags.',
          memoSource: 'ai' as const,
          advisoryChecks: [
            check({ code: 'cap', passed: true, blocking: true, label: 'cap cleared by AI' }),
            check({ code: 'ai_blocker', blocking: true, label: 'AI blocks' }),
            check({ code: 'deviation', source: 'deterministic', passed: true, label: 'spoofed' }),
            check({ code: 'ai_note', label: 'Holder D looks new' }),
          ],
          modelFingerprints: [{ label: 'ai-response', sha256: 'cd'.repeat(32) }],
        }),
    };
    const hostileModule = makeModule(world, { memoWriter: hostile });
    await runCycle(hostileModule, world, {
      cycleId: '2026-06',
      total: '300',
      trigger: 'prompt',
      promptText: 'Distribute 300 CC for June',
    });
    const record = (await world.ledger.reader.decisionRecords()).find(
      (r) => r.payload.cycleId === '2026-06',
    )?.payload;
    // The seven deterministic checks as the engine ran them, plus the one valid advisory flag.
    expect(record?.checks.map((c) => `${c.code}:${c.source}`)).toEqual([
      'cap:deterministic',
      'balance:deterministic',
      'non_holder:deterministic',
      'duplicate_cycle:deterministic',
      'deviation:deterministic',
      'unit_spike:deterministic',
      'prompt_amount:deterministic',
      'ai_note:ai',
    ]);
    expect(record?.checks.find((c) => c.code === 'ai_note')).toMatchObject({
      blocking: false,
      passed: false,
    });
    // The AI flag does not change the verdict: the deterministic checks all passed.
    expect(record?.verdict).toBe('AutoExecute');
    expect(record?.memoSource).toBe('ai');
    expect(record?.modelFingerprints.map((f) => f.label)).toEqual(['ai-response']);
    // A12: the prompt is fingerprinted.
    expect(record?.inputFingerprints.find((f) => f.label === 'prompt')?.sha256).toBe(
      sha256Hex('Distribute 300 CC for June'),
    );
    expect(record?.trigger).toBe('TriggerPrompt');
    // The decision record view marks the advisory check as AI.
    const view = await module.cycles.decisionRecord('decision/2026-06/1');
    expect(view.checks.filter((c) => c.source === 'ai')).toHaveLength(1);
  });

  it('a memo writer that fails leaves the proposal with a template memo marked ai-unavailable', async () => {
    const broken: MemoWriter = { write: () => Promise.reject(new Error('model timed out')) };
    const brokenModule = makeModule(world, { memoWriter: broken });
    await runCycle(brokenModule, world, { cycleId: '2026-05', total: '300' });
    const detail = await brokenModule.cycles.getCycle('2026-05');
    expect(detail.summary.status).toBe('countdown');
    expect(detail.proposal?.memoSource).toBe('ai-unavailable');
    expect(detail.proposal?.memo).toContain('All 7 checks passed.');
    expect(detail.timeline.find((s) => s.id === 'review')?.detail).toBe(
      'AI reviewer unavailable, template memo used',
    );
  });
});

describe('3b. the policy has a fixed amount: a prompt for another amount is flagged (A4, A12)', () => {
  let world: CycleWorld;
  let module: CycleModule;

  beforeAll(async () => {
    world = await createCycleWorld(handle, {
      holders: THREE_HOLDERS,
      funds: '1000000',
      terms: { fixedAmount: '300.0000000000' },
    });
    module = makeModule(world);
  });

  it('flags a prompt amount that differs from the fixed amount', async () => {
    const { cycleId } = await module.cycles.run({
      trigger: 'prompt',
      triggerDetail: 'Prompt by Treasurer',
      cycleId: '2026-09',
      total: '1500',
      promptText: 'Distribute 1,500 CC for September',
      modelFingerprints: [{ label: 'agent-turn', sha256: 'ee'.repeat(32) }],
      actorParty: world.parties.treasurer,
    });
    await module.cycles.settled();
    const detail = await module.cycles.getCycle(cycleId);
    expect(detail.proposal?.verdict).toBe('needs-approval');
    expect(detail.proposal?.checks.find((c) => c.code === 'prompt_amount')).toMatchObject({
      passed: false,
      actual: "A prompt asked for 1,500 CC, the policy's fixed amount is 300 CC",
    });
    expect(detail.decisionRecord?.modelFingerprints).toEqual([
      { label: 'agent-turn', sha256: 'ee'.repeat(32) },
    ]);
  });

  it('uses the fixed amount when no total is given, and a scheduled run is not subject to the prompt check', async () => {
    const { cycleId } = await module.cycles.run({
      trigger: 'schedule',
      triggerDetail: 'Schedule: Monthly on the 1st at 09:00 UTC',
      cycleId: '2026-08',
      actorParty: world.parties.agent,
    });
    await module.cycles.settled();
    const detail = await module.cycles.getCycle(cycleId);
    expect(detail.summary).toMatchObject({ total: '300.0000000000', trigger: 'schedule' });
    expect(detail.proposal?.checks.find((c) => c.code === 'prompt_amount')?.actual).toBe(
      'Not applicable',
    );
    expect(detail.proposal?.verdict).toBe('within-mandate');
  });
});

describe('3c. seeded cycles (demo history) are tagged on the ledger, others are not', () => {
  it('carries `seeded` from the run to the decision record, the proposal and the payments', async () => {
    const world = await createCycleWorld(handle, { holders: FOUR_HOLDERS, funds: '1000000' });
    const module = makeModule(world);
    // The activity table is shared by the worlds of this file: look only at what this test adds.
    const lastId = Math.max(0, ...(await world.activity.list(500)).map((e) => Number(e.id)));
    await runCycle(module, world, { cycleId: '2026-08', total: '300', seeded: true });
    await runCycle(module, world, { cycleId: '2026-09', total: '300' });

    const seededCycle = await module.cycles.getCycle('2026-08');
    const normalCycle = await module.cycles.getCycle('2026-09');
    expect(seededCycle.summary.seeded).toBe(true);
    expect(normalCycle.summary.seeded).toBe(false);
    const proposals = await world.ledger.reader.proposals();
    expect(proposals.find((p) => p.payload.cycleId === '2026-08')?.payload.seeded).toBe(true);
    expect(proposals.find((p) => p.payload.cycleId === '2026-09')?.payload.seeded).toBe(false);

    await sleep(1200); // the 1 s countdown
    await module.cycles.execute('2026-08');
    const payments = await world.ledger.reader.payments();
    expect(payments.length).toBe(4);
    expect(payments.every((p) => p.payload.seeded)).toBe(true);
    const outcomes = await world.ledger.reader.outcomes();
    expect(outcomes.find((o) => o.payload.cycleId === '2026-08')?.payload.seeded).toBe(true);

    // U8: the activity rows of a seeded run (proposed, paid) are tagged too, and only those.
    const activity = (await world.activity.list(500)).filter((e) => Number(e.id) > lastId);
    const of = (cycleId: string) => activity.filter((e) => e.link === `/app/cycles/${cycleId}`);
    expect(of('2026-08').map((e) => e.text)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Prepared August 2026/),
        expect.stringMatching(/^Paid 300 CC .* for August 2026/),
      ]),
    );
    expect(of('2026-08').every((e) => e.seeded)).toBe(true);
    expect(of('2026-09').length).toBeGreaterThan(0);
    expect(of('2026-09').every((e) => !e.seeded)).toBe(true);
    module.cycles.dispose();
  });
});

describe('4. hold: a held proposal does not execute; release executes it', () => {
  let world: CycleWorld;
  let module: CycleModule;

  beforeAll(async () => {
    world = await createCycleWorld(handle, { holders: THREE_HOLDERS, funds: '1000000' });
    module = makeModule(world);
  });

  it('hold during the countdown: nothing executes after the countdown passes', async () => {
    await runCycle(module, world, { cycleId: '2026-09' });
    const held = await module.cycles.hold('2026-09', world.parties.treasurer);
    expect(held.summary.status).toBe('held');
    expect(held.countdown?.held).toBe(true);
    // Holding again changes nothing.
    expect((await module.cycles.hold('2026-09', world.parties.treasurer)).summary.status).toBe(
      'held',
    );
    await sleep(1500);
    expect((await module.reconciler.reconcileOnce()).executed).toEqual([]);
    await expect(module.cycles.execute('2026-09')).rejects.toMatchObject({ code: 'held' });
    expect((await module.cycles.getCycle('2026-09')).summary.status).toBe('held');
    expect(await world.ledger.reader.payments()).toEqual([]);
    expect((await world.activity.list(10)).map((e) => e.text)).toContain(
      'Treasurer held September 2026',
    );
  });

  it('release after the countdown has passed executes now', async () => {
    const released = await module.cycles.release('2026-09', world.parties.treasurer);
    expect(['executing', 'countdown', 'paid-automatically']).toContain(released.summary.status);
    await module.cycles.settled();
    const done = await module.cycles.getCycle('2026-09');
    expect(done.summary.status).toBe('paid-automatically');
    expect(await world.ledger.reader.payments()).toHaveLength(3);
    // Too late to hold or cancel once paid.
    await expect(module.cycles.hold('2026-09', world.parties.treasurer)).rejects.toMatchObject({
      status: 409,
    });
    await expect(module.cycles.cancel('2026-09', world.parties.treasurer)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('release before the countdown has passed resumes it instead of paying at once', async () => {
    await runCycle(module, world, { cycleId: '2026-08' });
    await module.cycles.hold('2026-08', world.parties.treasurer);
    const resumed = await module.cycles.release('2026-08', world.parties.treasurer);
    expect(resumed.summary.status).toBe('countdown');
    expect(resumed.countdown?.held).toBe(false);
    expect((await module.reconciler.reconcileOnce()).executed).toEqual([]);
    await sleep(1300);
    expect((await module.reconciler.reconcileOnce()).executed).toEqual(['2026-08']);
    expect((await module.cycles.getCycle('2026-08')).summary.status).toBe('paid-automatically');
  });

  it('a proposal that waits for approvals has no countdown to hold', async () => {
    await runCycle(module, world, { cycleId: '2026-07', total: '50000' });
    await expect(module.cycles.hold('2026-07', world.parties.treasurer)).rejects.toMatchObject({
      code: 'not_holdable',
    });
  });
});

describe('5. low balance: needs-funds with the shortfall, nothing submitted (P5)', () => {
  let world: CycleWorld;
  let module: CycleModule;

  beforeAll(async () => {
    world = await createCycleWorld(handle, { holders: THREE_HOLDERS, funds: '100' });
    module = makeModule(world);
  });

  it('blocks execution with the shortfall and submits nothing', async () => {
    await runCycle(module, world, { cycleId: '2026-09', total: '300' });
    const detail = CycleDetailSchema.parse(await module.cycles.getCycle('2026-09'));
    // An empty treasury is not a reason to ask approvers: the balance check is not blocking.
    expect(detail.proposal?.verdict).toBe('within-mandate');
    const balanceCheck = detail.proposal?.checks.find((c) => c.code === 'balance');
    expect(balanceCheck).toMatchObject({ passed: false, blocking: false });
    expect(balanceCheck?.actual).toBe(
      'Balance 100 CC vs 301 CC needed (300 CC plus 1 CC fee buffer)',
    );
    expect(detail.summary.status).toBe('needs-funds');
    expect(detail.fundsShortfall).toEqual({
      balance: '100.0000000000',
      required: '301.0000000000',
    });

    await sleep(1300);
    expect((await module.reconciler.reconcileOnce()).executed).toEqual([]);
    const after = await module.cycles.getCycle('2026-09');
    expect(after.summary.status).toBe('needs-funds');
    expect(after.fundsShortfall).toEqual({ balance: '100.0000000000', required: '301.0000000000' });
    expect(world.submits.flatMap((s) => s.choices)).not.toContain('Mandate_AgentExecute');
    expect(await world.ledger.reader.payments()).toEqual([]);
    expect(await world.ledger.reader.proposals()).toHaveLength(1);
    const entries = (await world.activity.list(10)).map((e) => e.text);
    expect(entries.some((t) => t.includes('waiting for funds') && t.includes('Add funds'))).toBe(
      true,
    );
  });

  it('executes by itself once the treasury is funded', async () => {
    await addFunds(world, '1000');
    expect((await module.reconciler.reconcileOnce()).executed).toEqual(['2026-09']);
    const done = await module.cycles.getCycle('2026-09');
    expect(done.summary.status).toBe('paid-automatically');
    expect(done.fundsShortfall).toBeNull();
    same(await world.adapter.balance(world.parties.treasury), '800');
  });
});

describe('6. double run: one proposal per cycle, restarts do not repeat it, a second execution fails (L3)', () => {
  let world: CycleWorld;
  let module: CycleModule;

  beforeAll(async () => {
    world = await createCycleWorld(handle, { holders: THREE_HOLDERS, funds: '1000000' });
    module = makeModule(world);
  });

  it('two concurrent runs of the same cycle make one proposal', async () => {
    const input = {
      trigger: 'manual' as const,
      triggerDetail: 'Run cycle now by Treasurer',
      cycleId: '2026-09',
      total: '300',
      actorParty: world.parties.treasurer,
    };
    const [one, two] = await Promise.all([module.cycles.run(input), module.cycles.run(input)]);
    expect(one).toEqual({ cycleId: '2026-09' });
    expect(two).toEqual({ cycleId: '2026-09' });
    await module.cycles.settled();
    expect(await world.ledger.reader.proposals()).toHaveLength(1);
    expect(await world.ledger.reader.decisionRecords()).toHaveLength(1);
    const rows = await handle.db
      .select()
      .from(cycleRuns)
      .where(eq(cycleRuns.orgTreasury, world.parties.treasury));
    expect(rows).toHaveLength(1);
    // The timeline has one set of steps, not two.
    expect(
      (await module.cycles.getCycle('2026-09')).timeline.filter((s) => s.id === 'woke'),
    ).toHaveLength(1);
  });

  it('a restart (a new service instance) does not run the cycle again', async () => {
    const restarted = makeModule(world);
    const again = await restarted.cycles.run({
      trigger: 'schedule',
      triggerDetail: 'Schedule: Monthly on the 1st at 09:00 UTC',
      cycleId: '2026-09',
      total: '300',
      actorParty: world.parties.agent,
    });
    expect(again).toEqual({ cycleId: '2026-09' });
    await restarted.cycles.settled();
    expect(await world.ledger.reader.proposals()).toHaveLength(1);
    expect(await world.ledger.reader.decisionRecords()).toHaveLength(1);
    // The new instance knows the cycle from the database and the ledger, and pays it when due.
    expect((await restarted.cycles.getCycle('2026-09')).summary.status).toBe('countdown');
    await sleep(1300);
    expect((await restarted.reconciler.reconcileOnce()).executed).toEqual(['2026-09']);
    expect((await restarted.cycles.getCycle('2026-09')).summary.status).toBe('paid-automatically');
    module = restarted;
  });

  it('running an executed cycle again returns the same cycle and pays nothing twice', async () => {
    const again = await module.cycles.run({
      trigger: 'manual',
      triggerDetail: 'Run cycle now by Treasurer',
      cycleId: '2026-09',
      total: '300',
      actorParty: world.parties.treasurer,
    });
    expect(again).toEqual({ cycleId: '2026-09' });
    await module.cycles.settled();
    expect(await world.ledger.reader.payments()).toHaveLength(3);
    expect(await world.ledger.reader.decisionRecords()).toHaveLength(1);
    // The service reports a second execution attempt cleanly.
    await expect(module.cycles.execute('2026-09')).rejects.toMatchObject({
      status: 409,
      code: 'already_executed',
      message:
        'A distribution for September 2026 has already been executed. Nothing is paid twice.',
    });
  });

  it('the ledger refuses a second execution for the same cycle, and a new proposal for it (L3)', async () => {
    // A second proposal for the same cycle made before the first was paid (outside the engine).
    const second = await createCycleWorld(handle, { holders: THREE_HOLDERS, funds: '1000000' });
    const m2 = makeModule(second);
    await runCycle(m2, second, { cycleId: '2026-09' });
    const stray = await strayProposalInput(second, {
      cycleId: '2026-09',
      total: '300',
      attempt: 2,
    });
    const mandate = await second.ledger.reader.mandate();
    await second.ledger.client.submit({
      actAs: [second.parties.agent],
      readAs: [second.parties.treasury],
      commands: [second.ledger.commands.mandatePropose(mandate?.contractId ?? '', stray)],
      shape: 'LEDGER_EFFECTS',
    });
    const proposals = await second.ledger.reader.proposals();
    expect(proposals.map((p) => p.payload.proposalId).sort()).toEqual([
      'proposal/2026-09/1',
      'proposal/2026-09/2',
    ]);
    const first = proposals.find((p) => p.payload.proposalId === 'proposal/2026-09/1');

    // One of them is paid (the engine takes the newest open proposal of the cycle) ...
    await sleep(1300);
    expect((await m2.reconciler.reconcileOnce()).executed).toEqual(['2026-09']);
    expect((await m2.cycles.getCycle('2026-09')).summary.status).toBe('paid-automatically');
    // ... and the other can never execute: the ledger refuses, with the cycle label in the message.
    await expect(directExecute(second, first!)).rejects.toMatchObject({
      message: 'A distribution for September 2026 has already been executed',
    });
    // A new proposal for an executed cycle is refused too.
    const late = await strayProposalInput(second, {
      cycleId: '2026-09',
      total: '300',
      attempt: 3,
    });
    const current = await second.ledger.reader.mandate();
    await expect(
      second.ledger.client.submit({
        actAs: [second.parties.agent],
        readAs: [second.parties.treasury],
        commands: [second.ledger.commands.mandatePropose(current?.contractId ?? '', late)],
      }),
    ).rejects.toThrow('A distribution for Cycle 2026-09 has already been executed');
    expect(await second.ledger.reader.payments()).toHaveLength(3);
  });

  it('refuses to propose when the ledger already has an executed distribution for the cycle (duplicate_cycle check)', async () => {
    // The run table lost its row (a restored database); the ledger still knows the cycle was paid.
    await handle.db
      .delete(cycleRuns)
      .where(
        and(eq(cycleRuns.orgTreasury, world.parties.treasury), eq(cycleRuns.cycleId, '2026-09')),
      );
    await module.cycles.run({
      trigger: 'manual',
      triggerDetail: 'Run cycle now by Treasurer',
      cycleId: '2026-09',
      total: '300',
      actorParty: world.parties.treasurer,
    });
    await module.cycles.settled();
    const rows = await handle.db
      .select()
      .from(cycleRuns)
      .where(eq(cycleRuns.orgTreasury, world.parties.treasury));
    expect(rows[0]).toMatchObject({
      status: 'failed',
      error: 'A distribution for September 2026 has already been executed',
    });
    expect(await world.ledger.reader.decisionRecords()).toHaveLength(1);
    const timeline = (
      await new CycleStore(handle.db, world.parties.treasury).timeline('2026-09')
    ).filter((s) => s.id === 'checks');
    expect(timeline.at(-1)).toMatchObject({
      status: 'failed',
      detail: 'A distribution for September 2026 has already been executed',
    });
  });
});

describe('7. cancel by the treasurer (L11), reject by an approver, and the attempt number counts up', () => {
  let world: CycleWorld;
  let module: CycleModule;

  beforeAll(async () => {
    world = await createCycleWorld(handle, { holders: THREE_HOLDERS, funds: '1000000' });
    module = makeModule(world);
  });

  it('only the treasurer can cancel; the treasurer cancels and the outcome records who', async () => {
    await runCycle(module, world, { cycleId: '2026-09', total: '50000' });
    // An approver cannot cancel (the ledger: the choice is the treasurer\'s). The cycle is left as it was.
    await expect(module.cycles.cancel('2026-09', world.parties.approver1)).rejects.toBeInstanceOf(
      LedgerError,
    );
    expect((await module.cycles.getCycle('2026-09')).summary.status).toBe('awaiting-approval');

    const cancelled = await module.cycles.cancel('2026-09', world.parties.treasurer);
    expect(cancelled.summary.status).toBe('cancelled');
    expect(cancelled.outcome).toMatchObject({
      kind: 'cancelled',
      actor: { displayName: 'Treasurer' },
    });
    expect(await world.ledger.reader.proposals()).toEqual([]);
    expect(await world.ledger.reader.payments()).toEqual([]);
    await expect(module.cycles.cancel('2026-09', world.parties.treasurer)).rejects.toMatchObject({
      code: 'nothing_to_cancel',
    });
    expect((await world.activity.list(10)).map((e) => e.text)).toContain(
      'Treasurer cancelled September 2026',
    );
  });

  it('the next run of the same cycle is attempt 2', async () => {
    await runCycle(module, world, { cycleId: '2026-09', total: '50000' });
    const detail = await module.cycles.getCycle('2026-09');
    expect(detail.summary.status).toBe('awaiting-approval');
    expect(detail.proposal?.proposalId).toBe('proposal/2026-09/2');
    expect(detail.proposal?.decisionRecordId).toBe('decision/2026-09/2');
    expect(detail.outcome).toBeNull();
    // Only the latest attempt is on the timeline.
    expect(detail.timeline.filter((s) => s.id === 'woke')).toHaveLength(1);
    const records = (await world.ledger.reader.decisionRecords())
      .map((r) => r.payload.recordId)
      .sort();
    expect(records).toEqual(['decision/2026-09/1', 'decision/2026-09/2']);
  });

  it('an approver rejects with a reason; a rejection without one is refused', async () => {
    await expect(
      module.cycles.reject('proposal/2026-09/2', world.parties.approver2, ''),
    ).rejects.toMatchObject({
      message: 'A rejection needs a reason',
    });
    expect((await module.cycles.getCycle('2026-09')).summary.status).toBe('awaiting-approval');

    const rejected = await module.cycles.reject(
      'proposal/2026-09/2',
      world.parties.approver2,
      'Too much for this month',
    );
    expect(rejected.summary.status).toBe('rejected');
    expect(rejected.outcome).toMatchObject({
      kind: 'rejected',
      reason: 'Too much for this month',
      actor: { displayName: 'Approver 2' },
    });
    expect(await world.ledger.reader.payments()).toEqual([]);
    expect((await module.cycles.inbox(world.parties.approver1)).pending).toEqual([]);
    expect((await world.activity.list(10)).map((e) => e.text)).toContain(
      'Approver 2 rejected September 2026: Too much for this month',
    );
  });

  it('and again attempt 3 after the rejection; the proposal can still be paid after enough approvals', async () => {
    await runCycle(module, world, { cycleId: '2026-09', total: '50000' });
    const detail = await module.cycles.getCycle('2026-09');
    expect(detail.proposal?.decisionRecordId).toBe('decision/2026-09/3');
    await module.cycles.approve('proposal/2026-09/3', world.parties.approver1, '');
    await module.cycles.approve('proposal/2026-09/3', world.parties.approver3, '');
    await module.cycles.settled();
    const done = await module.cycles.getCycle('2026-09');
    expect(done.summary.status).toBe('paid-after-approval');
    expect(done.summary.approvals).toEqual({ have: 2, need: 2 });
    // 50,000 CC over 600 units: B holds 200 (16,666.666...), the residual goes to C, the largest holder.
    same(await world.adapter.balance(world.parties.holderB), '16666.6666666666');
    same(await world.adapter.balance(world.parties.holderC), '25000.0000000001');
  });
});

describe('7b. recovery after a crash', () => {
  it('frees a stale run and retries a stale execution', async () => {
    const world = await createCycleWorld(handle, { holders: THREE_HOLDERS, funds: '1000000' });
    const module = makeModule(world);
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

    // A run that never finished (the server died while preparing it).
    await handle.db.insert(cycleRuns).values({
      orgTreasury: world.parties.treasury,
      cycleId: '2026-03',
      status: 'running',
      trigger: 'manual',
      updatedAt: tenMinutesAgo,
    });
    // A payout the server died in the middle of (before the ledger answered).
    await runCycle(module, world, { cycleId: '2026-08', total: '300' });
    await handle.db
      .update(cycleRuns)
      .set({ status: 'executing', updatedAt: tenMinutesAgo })
      .where(
        and(eq(cycleRuns.orgTreasury, world.parties.treasury), eq(cycleRuns.cycleId, '2026-08')),
      );
    await sleep(1300);

    const report = await module.reconciler.reconcileOnce();
    expect(report.executed).toEqual(['2026-08']);
    const stale = await module.cycles.getCycle('2026-03');
    expect(stale.summary.status).toBe('failed');
    expect(stale.error).toContain('The run was interrupted');
    expect((await module.cycles.getCycle('2026-08')).summary.status).toBe('paid-automatically');
    expect(await world.ledger.reader.payments()).toHaveLength(3);
    // The interrupted cycle can be run again.
    await runCycle(module, world, { cycleId: '2026-03', total: '300' });
    expect((await module.cycles.getCycle('2026-03')).summary.status).toBe('countdown');
  });
});

/** An executor that waits for `open()` before it submits, to show what the UI sees while the ledger has not answered. */
function gatedExecutor(inner: PayoutExecutor) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const executor: PayoutExecutor = {
    async execute(request: ExecuteRequest) {
      await gate;
      return inner.execute(request);
    },
  };
  return { executor, open: release };
}

describe('9. P4: the UI never shows Paid before the ledger confirms', () => {
  let world: CycleWorld;
  let real: AgentPayoutExecutor;

  beforeAll(async () => {
    world = await createCycleWorld(handle, { holders: THREE_HOLDERS, funds: '1000000' });
    real = new AgentPayoutExecutor(
      world.ledger,
      { agent: world.parties.agent, treasury: world.parties.treasury },
      true,
    );
  });

  it('a submission that has not answered shows pending-ledger rows and never paid', async () => {
    const { executor, open } = gatedExecutor(real);
    const module = makeModule(world, { agentExecutor: executor });
    await runCycle(module, world, { cycleId: '2026-09' });
    await sleep(1300);
    const execution = module.cycles.execute('2026-09');
    const slow = await eventually(async () => {
      const d = await module.cycles.getCycle('2026-09');
      return d.summary.status === 'executing' && d.timeline.some((s) => s.id === 'execute')
        ? d
        : undefined;
    }, 'the execution to be in flight');
    expect(slow.proposal?.payouts.map((p) => p.payment?.status)).toEqual([
      'pending-ledger',
      'pending-ledger',
      'pending-ledger',
    ]);
    expect(JSON.stringify(slow)).not.toContain('"paid"');
    expect(slow.timeline.find((s) => s.id === 'execute')?.status).toBe('running');
    expect(await world.ledger.reader.payments()).toEqual([]);
    open();
    const done = await execution;
    expect(done.summary.status).toBe('paid-automatically');
    expect(done.proposal?.payouts.every((p) => p.payment?.status === 'paid')).toBe(true);
  });

  it('a submission the ledger refuses leaves the cycle failed with the reason, and no row is paid', async () => {
    const refusing: PayoutExecutor = {
      execute: () =>
        Promise.reject(
          new LedgerError({
            code: 'DAML_FAILURE',
            message: 'The transfer of 100 CC failed',
            retryable: false,
            status: 400,
          }),
        ),
    };
    const module = makeModule(world, { agentExecutor: refusing });
    await runCycle(module, world, { cycleId: '2026-08' });
    await sleep(1300);
    await expect(module.cycles.execute('2026-08')).rejects.toMatchObject({
      message: 'The transfer of 100 CC failed',
    });
    const failed = await module.cycles.getCycle('2026-08');
    expect(failed.summary.status).toBe('failed');
    expect(failed.error).toBe('The transfer of 100 CC failed');
    expect(failed.proposal?.payouts.map((p) => p.payment)).toEqual([null, null, null]);
    expect(failed.timeline.find((s) => s.id === 'execute')?.status).toBe('failed');
    expect(JSON.stringify(failed)).not.toContain('"paid"');
    expect(
      (await world.ledger.reader.payments()).filter((p) => p.payload.cycleId === '2026-08'),
    ).toEqual([]);
    // The reconciler does not retry a refused payout in a loop.
    expect((await module.reconciler.reconcileOnce()).executed).toEqual([]);

    // A new run cancels the stale proposal first and starts attempt 2.
    const retryModule = makeModule(world);
    await runCycle(retryModule, world, { cycleId: '2026-08' });
    const again = await retryModule.cycles.getCycle('2026-08');
    expect(again.proposal?.proposalId).toBe('proposal/2026-08/2');
    expect(again.summary.status).toBe('countdown');
    expect(again.error).toBeNull();
    // Leave nothing pending for the next test.
    await retryModule.cycles.cancel('2026-08', world.parties.treasurer);
  });

  it('a submission that cannot reach the ledger is retried, with the same command id, and nothing is paid twice', async () => {
    let calls = 0;
    const commandIds: string[] = [];
    const flaky: PayoutExecutor = {
      execute(request) {
        calls += 1;
        commandIds.push(request.commandId);
        if (calls === 1) {
          return Promise.reject(
            new LedgerError({
              code: 'LEDGER_UNREACHABLE',
              message: 'Cannot reach the ledger',
              retryable: true,
              status: 0,
            }),
          );
        }
        return real.execute(request);
      },
    };
    const module = makeModule(world, { agentExecutor: flaky });
    await runCycle(module, world, { cycleId: '2026-07' });
    await sleep(1300);
    expect((await module.reconciler.reconcileOnce()).executed).toEqual([]);
    const waiting = await module.cycles.getCycle('2026-07');
    expect(waiting.summary.status).not.toMatch(/^paid/);
    expect(waiting.error).toContain('has not confirmed the payments for July 2026');
    expect(JSON.stringify(waiting)).not.toContain('"paid"');
    expect((await module.reconciler.reconcileOnce()).executed).toEqual(['2026-07']);
    expect(commandIds).toEqual(['execute-proposal/2026-07/1', 'execute-proposal/2026-07/1']);
    const done = await module.cycles.getCycle('2026-07');
    expect(done.summary.status).toBe('paid-automatically');
    expect(done.error).toBeNull();
    expect(
      (await world.ledger.reader.payments()).filter((p) => p.payload.cycleId === '2026-07'),
    ).toHaveLength(3);
  });
});

describe('8. routes: roles, the contract shapes, approvals, the Mandate, drafts and transactions', () => {
  let world: CycleWorld;
  let module: CycleModule;
  let app: FastifyInstance;
  let sessions: SessionService;

  beforeAll(async () => {
    world = await createCycleWorld(handle, { holders: FOUR_HOLDERS, funds: '1000000' });
    module = makeModule(world);
    app = Fastify({ logger: false });
    await app.register(fastifyCookie, { secret: world.config.sessionSecret });
    sessions = new SessionService(handle.db);
    await app.register(sessionPlugin, {
      sessions,
      roleResolver: createRoleResolver({ reader: world.ledger.reader, db: handle.db }),
    });
    await app.register(module.routes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function as(
    party: string | null,
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: unknown,
  ) {
    const headers: Record<string, string> = {};
    if (party) {
      const session = await sessions.create(party);
      headers['cookie'] = `${SESSION_COOKIE}=${app.signCookie(session.id)}`;
    }
    return app.inject({
      method,
      url,
      headers,
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  }
  const p = (name: keyof CycleWorld['parties']): string => world.parties[name];
  const errorOf = (res: { json(): unknown }) =>
    (res.json() as { error: { code: string; message: string } }).error;

  it('requires a signed-in party with the right role', async () => {
    expect((await as(null, 'GET', '/api/cycles')).statusCode).toBe(401);
    // An approver cannot run a cycle; a holder cannot read the cycle list.
    const approverRun = await as(p('approver1'), 'POST', '/api/cycles/run', { total: '300' });
    expect(approverRun.statusCode).toBe(403);
    expect(errorOf(approverRun).code).toBe('forbidden_role');
    const holderList = await as(p('holderA'), 'GET', '/api/cycles');
    expect(holderList.statusCode).toBe(403);
    expect((await as(p('holderA'), 'GET', '/api/cycles/2026-09')).statusCode).toBe(403);
    expect((await as(p('approver1'), 'POST', '/api/cycles/2026-09/hold')).statusCode).toBe(403);
    expect((await as(p('treasurer'), 'GET', '/api/approvals')).statusCode).toBe(403);
    expect((await as(p('treasurer'), 'POST', '/api/proposals/x/approve', {})).statusCode).toBe(403);
    expect((await as(p('approver1'), 'PUT', '/api/policy/draft', {})).statusCode).toBe(403);
    expect(
      (await as(p('approver1'), 'POST', '/api/mandate/seal', { draftId: 'x' })).statusCode,
    ).toBe(403);
  });

  it('validates input and says what to do when no total is given', async () => {
    const noTotal = await as(p('treasurer'), 'POST', '/api/cycles/run', {});
    expect(noTotal.statusCode).toBe(422);
    const month = monthName(defaultCycleId(new Date()));
    expect(errorOf(noTotal)).toEqual({
      code: 'total_required',
      message: `Say how much to distribute, for example "Distribute 1,200 CC for ${month}."`,
    });
    const bad = await as(p('treasurer'), 'POST', '/api/cycles/run', { total: 'abc' });
    expect(bad.statusCode).toBe(400);
    expect(errorOf(bad).code).toBe('invalid_request');
    const future = await as(p('treasurer'), 'POST', '/api/cycles/run', {
      cycleId: '2099-01',
      total: '300',
    });
    expect(future.statusCode).toBe(422);
    expect(errorOf(future).code).toBe('record_date_in_future');
    // The Mandate's rule is the last day of the cycle month; the ledger enforces it, so the run
    // is refused up front with the reason, and nothing is reserved.
    const offRule = await as(p('treasurer'), 'POST', '/api/cycles/run', {
      cycleId: '2026-09',
      total: '300',
      recordDate: '2026-09-15',
    });
    expect(offRule.statusCode).toBe(422);
    expect(errorOf(offRule).code).toBe('invalid_record_date');
    expect(errorOf(offRule).message).toContain('last day of 2026-09');
    expect((await as(p('treasurer'), 'GET', '/api/cycles/2026-09')).statusCode).toBe(404);
    expect((await as(p('treasurer'), 'GET', '/api/cycles/2020-01')).statusCode).toBe(404);
  });

  it('runs a cycle and returns the contract shapes', async () => {
    const run = await as(p('treasurer'), 'POST', '/api/cycles/run', {
      cycleId: '2026-09',
      total: '300',
    });
    expect(run.statusCode).toBe(202);
    expect(run.json()).toEqual({ cycleId: '2026-09' });
    await module.cycles.settled();

    const detail = await as(p('treasurer'), 'GET', '/api/cycles/2026-09');
    expect(detail.statusCode).toBe(200);
    const parsed = CycleDetailSchema.parse(detail.json());
    expect(parsed.summary.status).toBe('countdown');
    expect(parsed.summary.trigger).toBe('manual');
    expect(parsed.timeline.length).toBe(6);
    expect(parsed.decisionRecord?.verdict).toBe('within-mandate');

    for (const who of ['treasurer', 'approver1'] as const) {
      const list = await as(p(who), 'GET', '/api/cycles');
      expect(list.statusCode).toBe(200);
      expect(CyclesResponseSchema.parse(list.json()).cycles.map((c) => c.cycleId)).toEqual([
        '2026-09',
      ]);
    }
    // The decision record, by an id with slashes in the URL.
    const record = await as(
      p('approver1'),
      'GET',
      `/api/decision-records/${encodeURIComponent('decision/2026-09/1')}`,
    );
    expect(record.statusCode).toBe(200);
    expect(DecisionRecordViewSchema.parse(record.json()).recordId).toBe('decision/2026-09/1');
    expect((await as(p('treasurer'), 'GET', '/api/decision-records/nope')).statusCode).toBe(404);
  });

  it('holds, releases and pays through the routes', async () => {
    const held = await as(p('treasurer'), 'POST', '/api/cycles/2026-09/hold');
    expect(held.statusCode).toBe(200);
    expect(CycleDetailSchema.parse(held.json()).summary.status).toBe('held');
    await sleep(1300);
    const released = await as(p('treasurer'), 'POST', '/api/cycles/2026-09/release');
    expect(released.statusCode).toBe(200);
    await module.cycles.settled();
    const paid = CycleDetailSchema.parse(
      (await as(p('treasurer'), 'GET', '/api/cycles/2026-09')).json(),
    );
    expect(paid.summary.status).toBe('awaiting-acceptance');
  });

  it('serves the transaction detail: a holder sees only their own payment (L7)', async () => {
    const detail = CycleDetailSchema.parse(
      (await as(p('treasurer'), 'GET', '/api/cycles/2026-09')).json(),
    );
    const updateId = detail.proposal?.payouts[0]?.payment?.link?.updateId ?? '';
    expect(updateId).not.toBe('');
    const treasurerView = await as(p('treasurer'), 'GET', `/api/tx/${updateId}`);
    expect(treasurerView.statusCode).toBe(200);
    const all = TxDetailSchema.parse(treasurerView.json());
    expect(all.payments.map((x) => x.holder.displayName).sort()).toEqual([
      'Holder A',
      'Holder B',
      'Holder C',
      'Holder D',
    ]);
    expect(all.payments.find((x) => x.holder.displayName === 'Holder D')?.status).toBe(
      'awaiting-acceptance',
    );
    expect((await as(p('approver1'), 'GET', `/api/tx/${updateId}`)).statusCode).toBe(200);

    const holderView = TxDetailSchema.parse(
      (await as(p('holderA'), 'GET', `/api/tx/${updateId}`)).json(),
    );
    expect(holderView.payments).toEqual([
      {
        holder: { partyId: p('holderA'), displayName: 'Holder A' },
        amount: '30.0000000000',
        status: 'paid',
        cycleLabel: 'September 2026',
      },
    ]);
    expect(JSON.stringify(holderView)).not.toContain(p('holderB'));
    const unknown = await as(p('holderA'), 'GET', '/api/tx/1220deadbeef');
    expect(unknown.statusCode).toBe(404);
    // Someone with no role cannot ask at all.
    expect((await as(p('outsider'), 'GET', `/api/tx/${updateId}`)).statusCode).toBe(403);
  });

  it('approves and rejects through the routes using the proposal id from the inbox', async () => {
    await runCycle(module, world, { cycleId: '2026-08', total: '50000' });
    const inbox = ApprovalsInboxSchema.parse(
      (await as(p('approver1'), 'GET', '/api/approvals')).json(),
    );
    expect(inbox.pending.map((i) => i.proposalId)).toEqual(['proposal/2026-08/1']);
    const url = `/api/proposals/${encodeURIComponent('proposal/2026-08/1')}`;

    const approved = await as(p('approver1'), 'POST', `${url}/approve`, { note: 'Reviewed' });
    expect(approved.statusCode).toBe(200);
    const afterApprove = CycleDetailSchema.parse(approved.json());
    expect(afterApprove.summary).toMatchObject({
      status: 'awaiting-approval',
      approvals: { have: 1, need: 2 },
    });
    // The same approver again: the ledger says why, as 422 ledger_rejected.
    const twice = await as(p('approver1'), 'POST', `${url}/approve`, {});
    expect(twice.statusCode).toBe(422);
    expect(errorOf(twice)).toEqual({
      code: 'ledger_rejected',
      message: 'This approver has already approved this proposal',
    });

    expect((await as(p('approver2'), 'POST', `${url}/reject`, { reason: '' })).statusCode).toBe(
      400,
    );
    expect((await as(p('approver2'), 'POST', `${url}/reject`, {})).statusCode).toBe(400);
    const rejected = await as(p('approver2'), 'POST', `${url}/reject`, {
      reason: 'Not this month',
    });
    expect(rejected.statusCode).toBe(200);
    expect(CycleDetailSchema.parse(rejected.json()).summary.status).toBe('rejected');
    expect(
      ApprovalsInboxSchema.parse((await as(p('approver1'), 'GET', '/api/approvals')).json())
        .pending,
    ).toEqual([]);
    expect(
      (await as(p('approver2'), 'POST', '/api/proposals/proposal%2Fnope%2F1/approve', {}))
        .statusCode,
    ).toBe(404);
  });

  it('cancels through the route; only the treasurer can', async () => {
    await runCycle(module, world, { cycleId: '2026-07', total: '50000' });
    expect((await as(p('approver1'), 'POST', '/api/cycles/2026-07/cancel')).statusCode).toBe(403);
    const cancelled = await as(p('treasurer'), 'POST', '/api/cycles/2026-07/cancel');
    expect(cancelled.statusCode).toBe(200);
    expect(CycleDetailSchema.parse(cancelled.json()).summary.status).toBe('cancelled');
    expect(errorOf(await as(p('treasurer'), 'POST', '/api/cycles/2026-07/cancel')).code).toBe(
      'nothing_to_cancel',
    );
  });

  it('shows the Mandate and edits a policy draft without sealing anything', async () => {
    const mandate = await as(p('approver1'), 'GET', '/api/mandate');
    expect(mandate.statusCode).toBe(200);
    const view = MandateViewSchema.parse(mandate.json());
    expect(view).toMatchObject({
      version: 1,
      agentExecutes: true,
      sealedBy: { displayName: 'Treasurer' },
      seal: { required: 1, signed: 1 },
      terms: {
        cap: '5000.0000000000',
        approvalThreshold: 2,
        assetSymbol: 'CC',
        scheduleText: 'Monthly on the 1st at 09:00 UTC',
        recordDateText: 'Last day of the previous month',
      },
    });
    expect(view.terms.approvers.map((a) => a.displayName)).toEqual([
      'Approver 1',
      'Approver 2',
      'Approver 3',
    ]);

    // No draft stored: the draft is built from the current Mandate.
    const current = PolicyDraftSchema.parse(
      (await as(p('treasurer'), 'GET', '/api/policy/draft')).json(),
    );
    expect(current).toMatchObject({ draftId: 'current-mandate', source: 'current-mandate' });
    expect(current.agentCannot.join('|')).toContain('Sign or change the Mandate');

    const edited = await as(p('treasurer'), 'PUT', '/api/policy/draft', {
      fields: { ...current.fields, cap: '3000' },
    });
    expect(edited.statusCode).toBe(200);
    const draft = PolicyDraftSchema.parse(edited.json());
    expect(draft.source).toBe('edited');
    expect(draft.fields.cap).toBe('3000');
    expect(draft.summary).toContain('at most 3,000 CC');
    expect(draft.draftId).not.toBe('current-mandate');
    // The summary is regenerated after another edit (A1).
    const again = PolicyDraftSchema.parse(
      (
        await as(p('treasurer'), 'PUT', '/api/policy/draft', {
          fields: { ...draft.fields, approvalThreshold: 3 },
        })
      ).json(),
    );
    expect(again.draftId).toBe(draft.draftId);
    expect(again.summary).toContain('needs 3 of 3 approvals');
    expect(
      PolicyDraftSchema.parse((await as(p('treasurer'), 'GET', '/api/policy/draft')).json()).fields
        .approvalThreshold,
    ).toBe(3);

    // Invalid edits are refused with what to change.
    const invalid = await as(p('treasurer'), 'PUT', '/api/policy/draft', {
      fields: { ...current.fields, approvalThreshold: 9 },
    });
    expect(invalid.statusCode).toBe(422);
    expect(errorOf(invalid).code).toBe('invalid_policy');
    expect(errorOf(invalid).message).toContain('Lower the threshold or add approvers');
    const agentApprover = await as(p('treasurer'), 'PUT', '/api/policy/draft', {
      fields: { ...current.fields, approvers: [p('agent'), p('approver1')] },
    });
    expect(errorOf(agentApprover).message).toContain('The agent cannot be an approver');
    // Nothing was sealed by editing.
    expect((await world.ledger.reader.mandate())?.payload.version).toBe(1);
  });

  it('seals a draft through the treasurer only: the agent cannot change the Mandate (L6)', async () => {
    const draft = PolicyDraftSchema.parse(
      (await as(p('treasurer'), 'GET', '/api/policy/draft')).json(),
    );
    // The agent cannot sign terms for the treasurer, cannot apply a seal, and neither can the treasurer alone.
    const { ledger, parties } = world;
    const terms = { ...world.terms, cap: '9999.0000000000' };
    await expect(
      ledger.client.submit({
        actAs: [parties.agent],
        commands: [
          ledger.commands.createMandateSealRequest({
            treasury: parties.treasury,
            treasurer: parties.treasurer,
            agent: parties.agent,
            terms,
            agentExecutes: true,
            summary: 'agent-made',
            summaryFingerprint: '00',
            requestedAt: new Date(),
          }),
        ],
      }),
    ).rejects.toBeInstanceOf(LedgerError);
    const [org, mandate] = await Promise.all([
      ledger.reader.organization(),
      ledger.reader.mandate(),
    ]);
    const request = await ledger.client.submit({
      actAs: [parties.treasurer],
      commands: [
        ledger.commands.createMandateSealRequest({
          treasury: parties.treasury,
          treasurer: parties.treasurer,
          agent: parties.agent,
          terms,
          agentExecutes: true,
          summary: 'treasurer-signed',
          summaryFingerprint: '00',
          requestedAt: new Date(),
        }),
      ],
      shape: 'LEDGER_EFFECTS',
    });
    const requestCid =
      request.events.find((e) => e.kind === 'created' && e.entity.endsWith('MandateSealRequest'))
        ?.contractId ?? '';
    for (const actor of [parties.agent, parties.treasurer]) {
      await expect(
        ledger.client.submit({
          actAs: [actor],
          readAs: [parties.treasury],
          commands: [
            ledger.commands.orgApplySeal(org?.contractId ?? '', {
              sealRequestCid: requestCid,
              currentMandateCid: mandate?.contractId ?? null,
            }),
          ],
        }),
      ).rejects.toBeInstanceOf(LedgerError);
    }
    // Withdraw the request again so it does not linger.
    await ledger.client.submit({
      actAs: [parties.treasurer],
      commands: [ledger.commands.sealRequestWithdraw(requestCid)],
    });
    expect((await ledger.reader.mandate())?.payload.version).toBe(1);

    // Through the route: only the treasurer, only a draft that is theirs.
    expect(
      (await as(p('approver1'), 'POST', '/api/mandate/seal', { draftId: draft.draftId }))
        .statusCode,
    ).toBe(403);
    expect(
      errorOf(await as(p('treasurer'), 'POST', '/api/mandate/seal', { draftId: 'missing' })).code,
    ).toBe('draft_not_found');
    const sealed = await as(p('treasurer'), 'POST', '/api/mandate/seal', {
      draftId: draft.draftId,
    });
    expect(sealed.statusCode).toBe(200);
    const status = SealStatusSchema.parse(sealed.json());
    expect(status).toMatchObject({
      state: 'sealed',
      treasurerSigned: true,
      mandateVersion: 2,
      error: null,
    });
    expect(
      SealStatusSchema.parse(
        (await as(p('treasurer'), 'GET', `/api/mandate/seal/${status.sealId}`)).json(),
      ).state,
    ).toBe('sealed');

    const after = MandateViewSchema.parse((await as(p('treasurer'), 'GET', '/api/mandate')).json());
    expect(after).toMatchObject({
      version: 2,
      terms: { cap: '3000.0000000000', approvalThreshold: 3 },
    });
    // The executed cycles carried over to the new Mandate.
    expect(after.executedCycles).toEqual(['2026-09']);
    // The new terms apply at once: 4,000 CC is now above the cap.
    await runCycle(module, world, { cycleId: '2026-06', total: '4000' });
    expect((await module.cycles.getCycle('2026-06')).proposal?.verdict).toBe('needs-approval');
    expect((await module.cycles.getCycle('2026-06')).summary.approvals).toEqual({
      have: 0,
      need: 3,
    });
  });
});
