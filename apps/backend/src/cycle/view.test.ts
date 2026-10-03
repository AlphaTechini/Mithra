import { CycleDetailSchema, CycleSummarySchema } from '@mithra/shared';
import { describe, expect, it } from 'vitest';
import type {
  Contract,
  DecisionRecord,
  DistributionOutcome,
  Mandate,
  Payment,
  Proposal,
} from '../ledger';
import { txLinkFor } from './links';
import { localnetTestConfig } from '../testConfig';
import {
  deriveStatus,
  detailOf,
  groupCycles,
  inboxOf,
  summaryOf,
  verdictReasons,
  type CycleFacts,
  type LedgerFacts,
  type RunState,
  type ViewContext,
} from './view';

const NOW = new Date('2026-10-01T12:00:00Z');
const H = (n: string): string => `${n}::1220aa`;

function contract<T>(
  contractId: string,
  payload: T,
  createdAt = '2026-10-01T11:00:00Z',
): Contract<T> {
  return { contractId, payload, createdAt };
}

const payouts = [
  { holder: H('a'), units: 100, amount: '100.0000000000' },
  { holder: H('b'), units: 200, amount: '200.0000000000' },
];

const check = (code: string, passed: boolean, blocking = true) => ({
  code,
  label: code,
  passed,
  blocking,
  actual: `${code} actual`,
  limit: `${code} limit`,
  source: 'deterministic',
});

function record(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    recordId: 'decision/2026-09/1',
    treasury: H('treasury'),
    treasurer: H('treasurer'),
    agent: H('agent'),
    approvers: [H('p1'), H('p2'), H('p3')],
    cycleId: '2026-09',
    cycleLabel: 'September 2026',
    trigger: 'TriggerManual',
    triggerDetail: 'Run cycle now',
    recordDate: '2026-09-30',
    total: '300.0000000000',
    payouts,
    inputFingerprints: [],
    checks: [check('cap', true), check('deviation', true)],
    memo: 'memo',
    memoSource: 'template',
    modelFingerprints: [],
    verdict: 'AutoExecute',
    mandateVersion: 1,
    cap: '5000.0000000000',
    createdAt: '2026-10-01T11:00:00Z',
    seeded: false,
    ...overrides,
  };
}

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    treasury: H('treasury'),
    treasurer: H('treasurer'),
    agent: H('agent'),
    proposalId: 'proposal/2026-09/1',
    cycleId: '2026-09',
    cycleLabel: 'September 2026',
    recordDate: '2026-09-30',
    total: '300.0000000000',
    payouts,
    verdict: 'AutoExecute',
    approvers: [H('p1'), H('p2'), H('p3')],
    approvalThreshold: 2,
    approvals: [],
    decisionRecordCid: 'dr1',
    decisionRecordId: 'decision/2026-09/1',
    mandateVersion: 1,
    createdAt: '2026-10-01T11:00:00Z',
    seeded: false,
    ...overrides,
  };
}

function outcome(overrides: Partial<DistributionOutcome> = {}): DistributionOutcome {
  return {
    recordId: 'outcome/2026-09/1',
    treasury: H('treasury'),
    treasurer: H('treasurer'),
    agent: H('agent'),
    approvers: [H('p1'), H('p2'), H('p3')],
    decisionRecordId: 'decision/2026-09/1',
    cycleId: '2026-09',
    cycleLabel: 'September 2026',
    kind: 'Executed',
    approvals: [],
    payments: payouts.map((p, i) => ({
      holder: p.holder,
      amount: p.amount,
      paymentCid: `pay${i}`,
      status: 'Paid' as const,
      transferInstructionCid: null,
    })),
    actor: H('agent'),
    reason: null,
    at: '2026-10-01T11:30:00Z',
    seeded: false,
    ...overrides,
  };
}

function payment(holder: string, status: Payment['status'], cid: string): Contract<Payment> {
  return contract(cid, {
    treasury: H('treasury'),
    agent: H('agent'),
    holder,
    cycleId: '2026-09',
    cycleLabel: 'September 2026',
    units: 100,
    amount: '100.0000000000',
    status,
    transferInstructionCid: status === 'AwaitingAcceptance' ? 'ti' : null,
    executedAt: '2026-10-01T11:30:00Z',
    seeded: false,
    externalReceiver: status === 'PendingExternal' ? `${holder}-mainnet::1220ab` : null,
    externalTxRef: null,
  });
}

const mandate: Contract<Mandate> = contract('m1', {
  treasury: H('treasury'),
  treasurer: H('treasurer'),
  agent: H('agent'),
  version: 1,
  terms: {
    cap: '5000.0000000000',
    approvers: [H('p1'), H('p2'), H('p3')],
    approvalThreshold: 2,
    asset: { admin: H('dso'), id: 'CC' },
    scheduleCron: '0 9 1 * *',
    scheduleTimezone: 'UTC',
    recordDateRule: 'last_day_of_previous_month',
    fixedAmount: null,
    deviationPct: '50.0000000000',
    trailingCycles: 3,
    unitChangePct: '100.0000000000',
    unitChangeWindowDays: 3,
    feeBuffer: '1.0000000000',
  },
  agentExecutes: true,
  executedCycles: [],
  cycleAttempts: [],
  sealedAt: '2026-09-01T00:00:00Z',
  summaryFingerprint: 'ff',
});

function run(overrides: Partial<RunState> = {}): RunState {
  return {
    status: 'proposed',
    startedAt: new Date('2026-10-01T10:59:00Z'),
    error: null,
    trigger: 'manual',
    total: '300',
    recordDate: '2026-09-30',
    executesAt: new Date('2026-10-01T12:00:30Z'),
    held: false,
    waitingForWallets: false,
    fundsShortfall: null,
    ...overrides,
  };
}

function facts(parts: Partial<LedgerFacts>, row: RunState | null): CycleFacts {
  const ledger: LedgerFacts = {
    mandate,
    proposals: [],
    records: [],
    outcomes: [],
    payments: [],
    ...parts,
  };
  const [cf] = groupCycles(new Map(row ? [['2026-09', row]] : []), ledger);
  if (!cf) throw new Error('no cycle');
  return cf;
}

const ctx: ViewContext = {
  now: NOW,
  assetSymbol: 'CC',
  refOf: (partyId) => ({ partyId, displayName: partyId.split('::')[0] ?? partyId }),
  updateIdOf: (cid) => (cid.startsWith('pay') ? `update-${cid}` : null),
  linkFor: (updateId) => txLinkFor(localnetTestConfig(), updateId),
};

const status = (cf: CycleFacts): string => deriveStatus(cf, mandate, NOW);

describe('cycle status mapping', () => {
  it('running: a run row without a proposal', () => {
    expect(status(facts({}, run({ status: 'running', executesAt: null })))).toBe('running');
  });

  it('countdown, then held, for a within-mandate proposal', () => {
    const base = { proposals: [contract('p', proposal())], records: [contract('r', record())] };
    expect(status(facts(base, run()))).toBe('countdown');
    expect(status(facts(base, run({ held: true })))).toBe('held');
  });

  it('a proposal whose countdown is over and that is not held is executing', () => {
    const base = { proposals: [contract('p', proposal())], records: [contract('r', record())] };
    expect(status(facts(base, run({ executesAt: new Date('2026-10-01T11:59:00Z') })))).toBe(
      'executing',
    );
  });

  it('awaiting-approval below the threshold, using the true ledger count (U3)', () => {
    const needs = proposal({ verdict: 'NeedsApproval' });
    const one = proposal({
      verdict: 'NeedsApproval',
      approvals: [{ approver: H('p1'), at: '2026-10-01T11:10:00Z', note: '' }],
    });
    const records = [contract('r', record({ verdict: 'NeedsApproval' }))];
    expect(
      status(facts({ proposals: [contract('p', needs)], records }, run({ executesAt: null }))),
    ).toBe('awaiting-approval');
    const cfOne = facts({ proposals: [contract('p', one)], records }, run({ executesAt: null }));
    expect(status(cfOne)).toBe('awaiting-approval');
    expect(summaryOf(cfOne, mandate, ctx).approvals).toEqual({ have: 1, need: 2 });
  });

  it('does not count an approval twice or from someone outside the Mandate', () => {
    const forged = proposal({
      verdict: 'NeedsApproval',
      approvals: [
        { approver: H('p1'), at: '2026-10-01T11:10:00Z', note: '' },
        { approver: H('p1'), at: '2026-10-01T11:11:00Z', note: '' },
        { approver: H('outsider'), at: '2026-10-01T11:12:00Z', note: '' },
      ],
    });
    const cf = facts(
      {
        proposals: [contract('p', forged)],
        records: [contract('r', record({ verdict: 'NeedsApproval' }))],
      },
      run({ executesAt: null }),
    );
    expect(summaryOf(cf, mandate, ctx).approvals).toEqual({ have: 1, need: 2 });
    expect(status(cf)).toBe('awaiting-approval');
  });

  it('needs-funds when the run row holds a shortfall (P5)', () => {
    const base = { proposals: [contract('p', proposal())], records: [contract('r', record())] };
    expect(status(facts(base, run({ fundsShortfall: { balance: '100', required: '301' } })))).toBe(
      'needs-funds',
    );
  });

  it('executing while the submission is in flight, whatever the countdown says', () => {
    const base = { proposals: [contract('p', proposal())], records: [contract('r', record())] };
    expect(status(facts(base, run({ status: 'executing' })))).toBe('executing');
  });

  it('failed with its error', () => {
    const base = { proposals: [contract('p', proposal())], records: [contract('r', record())] };
    const cf = facts(base, run({ status: 'failed', error: 'Total is above the cap' }));
    expect(status(cf)).toBe('failed');
    expect(detailOf(cf, mandate, ctx, []).error).toBe('Total is above the cap');
    expect(status(facts({}, run({ status: 'failed', error: 'x', executesAt: null })))).toBe(
      'failed',
    );
  });

  it('paid-automatically and paid-after-approval come from the outcome and verdict', () => {
    const auto = facts(
      {
        records: [contract('r', record())],
        outcomes: [contract('o', outcome())],
        payments: [payment(H('a'), 'Paid', 'pay0'), payment(H('b'), 'Paid', 'pay1')],
      },
      run({ status: 'executed' }),
    );
    expect(status(auto)).toBe('paid-automatically');
    const approvals = [
      { approver: H('p1'), at: '2026-10-01T11:10:00Z', note: '' },
      { approver: H('p2'), at: '2026-10-01T11:11:00Z', note: '' },
    ];
    const approved = facts(
      {
        records: [contract('r', record({ verdict: 'NeedsApproval' }))],
        outcomes: [contract('o', outcome({ approvals }))],
        payments: [payment(H('a'), 'Paid', 'pay0'), payment(H('b'), 'Paid', 'pay1')],
      },
      run({ status: 'executed' }),
    );
    expect(status(approved)).toBe('paid-after-approval');
    expect(summaryOf(approved, mandate, ctx).approvals).toEqual({ have: 2, need: 2 });
  });

  it('awaiting-acceptance while any Payment awaits the holder (P2)', () => {
    const cf = facts(
      {
        records: [contract('r', record())],
        outcomes: [contract('o', outcome())],
        payments: [payment(H('a'), 'Paid', 'pay0'), payment(H('b'), 'AwaitingAcceptance', 'pay1')],
      },
      run({ status: 'executed' }),
    );
    expect(status(cf)).toBe('awaiting-acceptance');
  });

  it('rejected and cancelled come from the outcome', () => {
    const records = [contract('r', record({ verdict: 'NeedsApproval' }))];
    const rejected = facts(
      {
        records,
        outcomes: [
          contract(
            'o',
            outcome({ kind: 'Rejected', reason: 'Too high', actor: H('p1'), payments: [] }),
          ),
        ],
      },
      run({ status: 'rejected' }),
    );
    expect(status(rejected)).toBe('rejected');
    const cancelled = facts(
      {
        records,
        outcomes: [
          contract('o', outcome({ kind: 'Cancelled', actor: H('treasurer'), payments: [] })),
        ],
      },
      run({ status: 'cancelled' }),
    );
    expect(status(cancelled)).toBe('cancelled');
    expect(detailOf(rejected, mandate, ctx, []).outcome).toMatchObject({
      kind: 'rejected',
      reason: 'Too high',
      actor: { displayName: 'p1' },
    });
  });

  it('a new attempt after a rejection shows running, then its own proposal', () => {
    const old = [contract('r1', record({ verdict: 'NeedsApproval' }))];
    const rejected = contract(
      'o1',
      outcome({ kind: 'Rejected', reason: 'no', actor: H('p1'), payments: [] }),
    );
    const running = facts(
      { records: old, outcomes: [rejected] },
      run({ status: 'running', startedAt: new Date('2026-10-01T11:45:00Z'), executesAt: null }),
    );
    expect(status(running)).toBe('running');
    const second = [
      ...old,
      contract('r2', record({ recordId: 'decision/2026-09/2', verdict: 'AutoExecute' })),
    ];
    const proposed = facts(
      {
        records: second,
        outcomes: [rejected],
        proposals: [
          contract(
            'p2',
            proposal({ proposalId: 'proposal/2026-09/2', decisionRecordId: 'decision/2026-09/2' }),
          ),
        ],
      },
      run(),
    );
    expect(status(proposed)).toBe('countdown');
    expect(proposed.attempts).toBe(2);
  });
});

describe('P4: Paid only comes from the ledger', () => {
  const payoutRowStatuses = (cf: CycleFacts): (string | null)[] =>
    detailOf(cf, mandate, ctx, []).proposal?.payouts.map((p) => p.payment?.status ?? null) ?? [];

  it('a submission in flight shows every row as pending-ledger, never paid', () => {
    const cf = facts(
      { proposals: [contract('p', proposal())], records: [contract('r', record())] },
      run({ status: 'executing' }),
    );
    expect(payoutRowStatuses(cf)).toEqual(['pending-ledger', 'pending-ledger']);
  });

  it('a failed submission leaves the rows without a payment', () => {
    const cf = facts(
      { proposals: [contract('p', proposal())], records: [contract('r', record())] },
      run({ status: 'failed', error: 'The ledger refused' }),
    );
    expect(payoutRowStatuses(cf)).toEqual([null, null]);
    expect(JSON.stringify(detailOf(cf, mandate, ctx, []))).not.toContain('"paid"');
  });

  it('a run row that says executed without a ledger outcome never shows as paid', () => {
    const cf = facts({ records: [contract('r', record())] }, run({ status: 'executed' }));
    expect(status(cf)).toBe('executing');
    expect(payoutRowStatuses(cf)).toEqual(['pending-ledger', 'pending-ledger']);
  });

  it('a paid outcome shows as executing until the engine has recorded the payout and marked the row', () => {
    const ledger = {
      records: [contract('r', record())],
      outcomes: [contract('o', outcome())],
      payments: [payment(H('a'), 'Paid', 'pay0'), payment(H('b'), 'AwaitingAcceptance', 'pay1')],
    };
    expect(status(facts(ledger, run({ status: 'executing' })))).toBe('executing');
    expect(status(facts(ledger, run({ status: 'executed' })))).toBe('awaiting-acceptance');
    // Another instance paid it and this one has no row: the ledger alone decides.
    expect(status(facts(ledger, null))).toBe('awaiting-acceptance');
  });

  it('a row is paid only when its Payment contract has status Paid, with an in-app link', () => {
    const cf = facts(
      {
        records: [contract('r', record())],
        outcomes: [contract('o', outcome())],
        payments: [payment(H('a'), 'Paid', 'pay0'), payment(H('b'), 'AwaitingAcceptance', 'pay1')],
      },
      run({ status: 'executed' }),
    );
    const rows = detailOf(cf, mandate, ctx, []).proposal?.payouts ?? [];
    expect(rows.map((r) => r.payment?.status)).toEqual(['paid', 'awaiting-acceptance']);
    expect(rows[0]?.payment?.link).toEqual({
      updateId: 'update-pay0',
      href: '/app/tx/update-pay0',
      external: false,
    });
  });
});

describe('response shapes', () => {
  it('detail and summary parse with the shared schemas', () => {
    const cf = facts(
      {
        proposals: [
          contract(
            'p',
            proposal({
              verdict: 'NeedsApproval',
              approvals: [{ approver: H('p1'), at: '2026-10-01T11:10:00Z', note: 'ok' }],
            }),
          ),
        ],
        records: [
          contract(
            'r',
            record({
              verdict: 'NeedsApproval',
              total: '6000.0000000000',
              checks: [check('cap', false), check('deviation', false)],
            }),
          ),
        ],
      },
      run({ executesAt: null }),
    );
    const detail = detailOf(cf, mandate, ctx, [
      { id: 'woke', label: 'Woke up', status: 'done', detail: 'x', at: '2026-10-01T11:00:00Z' },
    ]);
    expect(CycleDetailSchema.parse(detail).summary.status).toBe('awaiting-approval');
    expect(CycleSummarySchema.parse(summaryOf(cf, mandate, ctx)).flagCount).toBe(2);
    expect(detail.proposal?.verdictReasons).toEqual([
      'Total is above the 5,000 CC cap',
      'deviation actual',
    ]);
    expect(detail.proposal?.payouts.map((p) => p.sharePct)).toEqual(['33.33', '66.67']);
    expect(detail.countdown).toBeNull();
  });

  it('countdown carries executesAt and held for within-mandate proposals', () => {
    const cf = facts(
      { proposals: [contract('p', proposal())], records: [contract('r', record())] },
      run({ held: true }),
    );
    expect(detailOf(cf, mandate, ctx, []).countdown).toEqual({
      executesAt: '2026-10-01T12:00:30.000Z',
      held: true,
    });
  });

  it('verdict reasons are empty for a within-mandate proposal', () => {
    expect(verdictReasons(record(), 'CC')).toEqual([]);
  });

  it('the inbox lists proposals below the threshold, and whether you approved', () => {
    const one = proposal({
      verdict: 'NeedsApproval',
      approvals: [{ approver: H('p1'), at: '2026-10-01T11:10:00Z', note: '' }],
    });
    const cf = facts(
      {
        proposals: [contract('p', one)],
        records: [
          contract('r', record({ verdict: 'NeedsApproval', checks: [check('deviation', false)] })),
        ],
      },
      run({ executesAt: null }),
    );
    const inbox = inboxOf([cf], mandate, H('p1'));
    expect(inbox.pending).toEqual([
      {
        cycleId: '2026-09',
        proposalId: 'proposal/2026-09/1',
        label: 'September 2026',
        total: '300.0000000000',
        flagCount: 1,
        approvals: { have: 1, need: 2 },
        youApproved: true,
        createdAt: '2026-10-01T11:00:00Z',
      },
    ]);
    expect(inboxOf([cf], mandate, H('p2')).pending[0]?.youApproved).toBe(false);
    expect(inboxOf([cf], mandate, H('outsider')).pending).toEqual([]);
  });
});

describe('MainNet payouts (M10)', () => {
  const executedFacts = (
    statuses: [Payment['status'], Payment['status']],
    txRefs = [null, null] as (string | null)[],
  ) => {
    const [a, b] = statuses;
    const pa = payment(H('a'), a, 'mx0');
    const pb = payment(H('b'), b, 'mx1');
    pa.payload.externalTxRef = txRefs[0] ?? null;
    pb.payload.externalTxRef = txRefs[1] ?? null;
    return facts(
      {
        records: [contract('r', record())],
        outcomes: [
          contract(
            'o',
            outcome({
              payments: payouts.map((p, i) => ({
                holder: p.holder,
                amount: p.amount,
                paymentCid: `mx${i}`,
                status: 'PendingExternal' as const,
                transferInstructionCid: null,
              })),
            }),
          ),
        ],
        payments: [pa, pb],
      },
      run({ status: 'executed' }),
    );
  };
  const rows = (cf: CycleFacts) =>
    detailOf(cf, mandate, ctx, []).proposal?.payouts.map((p) => p.payment) ?? [];

  it('awaiting-signature while a payment is PendingExternal; rows stay pending-ledger (P4)', () => {
    const cf = executedFacts(['PendingExternal', 'PendingExternal']);
    expect(status(cf)).toBe('awaiting-signature');
    expect(rows(cf)).toEqual([
      { status: 'pending-ledger', link: null },
      { status: 'pending-ledger', link: null },
    ]);
    expect(JSON.stringify(detailOf(cf, mandate, ctx, []))).not.toContain('"paid"');
  });

  it('a recorded payment is paid with its explorer link; the others still wait', () => {
    const cf = executedFacts(['Paid', 'PendingExternal'], ['upd-a', null]);
    expect(status(cf)).toBe('awaiting-signature');
    expect(rows(cf)).toEqual([
      { status: 'paid', link: { updateId: 'upd-a', href: '/app/tx/upd-a', external: false } },
      { status: 'pending-ledger', link: null },
    ]);
  });

  it('awaiting-acceptance when every transfer is recorded and one still needs the holder', () => {
    const cf = executedFacts(['Paid', 'AwaitingAcceptance'], ['upd-a', 'upd-b']);
    expect(status(cf)).toBe('awaiting-acceptance');
    expect(rows(cf)[1]).toMatchObject({ status: 'awaiting-acceptance' });
  });

  it('paid-automatically once every payment is recorded as paid', () => {
    expect(status(executedFacts(['Paid', 'Paid'], ['upd-a', 'upd-b']))).toBe('paid-automatically');
  });

  it('needs-wallets when the proposal may run but payees have no Grofty wallet', () => {
    const base = {
      proposals: [contract('p', proposal())],
      records: [contract('r', record())],
    };
    const due = run({ executesAt: new Date('2026-10-01T11:59:00Z') });
    const cf = facts(base, due);
    cf.missingWallets = [H('b')];
    // Until the engine has looked at it and recorded the wait, the cycle is still executing.
    expect(status(cf)).toBe('executing');
    cf.row = { ...due, waitingForWallets: true };
    expect(status(cf)).toBe('needs-wallets');
    expect(detailOf(cf, mandate, ctx, []).needsWallets).toEqual([
      { partyId: H('b'), displayName: 'b' },
    ]);
    // Still a countdown while the countdown runs, and not needing wallets once everyone connected.
    const early = facts(base, run());
    early.missingWallets = [H('b')];
    expect(status(early)).toBe('countdown');
    cf.missingWallets = [];
    expect(status(cf)).toBe('executing');
    expect(detailOf(cf, mandate, ctx, []).needsWallets).toBeUndefined();
  });

  it('needs-wallets for a flagged proposal once the approval threshold is met', () => {
    const approved = proposal({
      verdict: 'NeedsApproval',
      approvals: [
        { approver: H('p1'), at: '2026-10-01T11:10:00Z', note: '' },
        { approver: H('p2'), at: '2026-10-01T11:11:00Z', note: '' },
      ],
    });
    const cf = facts(
      {
        proposals: [contract('p', approved)],
        records: [contract('r', record({ verdict: 'NeedsApproval' }))],
      },
      run({ executesAt: null }),
    );
    cf.missingWallets = [H('a')];
    expect(status(cf)).toBe('executing');
    cf.row = run({ executesAt: null, waitingForWallets: true });
    expect(status(cf)).toBe('needs-wallets');
  });
});
