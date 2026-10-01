import { EvidenceRoomSchema, RecordPreviewSchema } from '@mithra/shared';
import { describe, expect, it } from 'vitest';
import type { DecisionRecord, DistributionOutcome, Evidence } from '../ledger';
import {
  auditorTxLink,
  createRedactor,
  evidenceMarkdown,
  holderLabel,
  holderLabelsFor,
  previewDecision,
  previewOutcome,
  previewUnavailable,
  toEvidenceRecord,
  toEvidenceRecords,
  type EvidenceContext,
} from './evidence';

// Long, realistic party ids: the tests search the evidence for them.
const NS = '1220' + 'ab'.repeat(30);
const party = (hint: string): string => `${hint}::${NS}`;
const HOLDER_Z = party('zeta-holder');
const HOLDER_A = party('alpha-holder');
const HOLDER_M = party('mid-holder');
const APPROVER_1 = party('approver1');
const APPROVER_2 = party('approver2');
const AGENT = party('agent');

function decision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    recordId: 'decision/2026-09/1',
    treasury: party('treasury'),
    treasurer: party('treasurer'),
    agent: AGENT,
    approvers: [APPROVER_1, APPROVER_2, party('approver3')],
    cycleId: '2026-09',
    cycleLabel: 'September 2026',
    trigger: 'TriggerManual',
    triggerDetail: 'Run cycle now by Treasurer',
    recordDate: '2026-08-31',
    total: '1200.0000000000',
    payouts: [
      { holder: HOLDER_Z, units: 500, amount: '600.0000000000' },
      { holder: HOLDER_A, units: 300, amount: '360.0000000000' },
      { holder: HOLDER_M, units: 200, amount: '240.0000000000' },
    ],
    inputFingerprints: [{ label: 'register', sha256: 'a'.repeat(64) }],
    checks: [
      {
        code: 'unit_spike',
        label: 'No sharp change in holder units',
        passed: false,
        blocking: true,
        actual: 'Mid Fund Ltd: 100 → 900 units (+800%)',
        limit: 'No holder changes by more than 25%',
        source: 'deterministic',
      },
    ],
    memo: 'The largest payment is 600 CC to Zeta Capital (50% of units).',
    memoSource: 'template',
    modelFingerprints: [{ label: 'memo', sha256: 'b'.repeat(64) }],
    verdict: 'NeedsApproval',
    mandateVersion: 1,
    cap: '5000.0000000000',
    createdAt: '2026-09-01T09:00:00.000Z',
    seeded: false,
    ...overrides,
  };
}

function outcome(overrides: Partial<DistributionOutcome> = {}): DistributionOutcome {
  return {
    recordId: 'outcome/2026-09/1',
    treasury: party('treasury'),
    treasurer: party('treasurer'),
    agent: AGENT,
    approvers: [APPROVER_1, APPROVER_2, party('approver3')],
    decisionRecordId: 'decision/2026-09/1',
    cycleId: '2026-09',
    cycleLabel: 'September 2026',
    kind: 'Executed',
    approvals: [
      { approver: APPROVER_1, at: '2026-09-01T10:00:00.000Z', note: 'Checked the unit change' },
      { approver: APPROVER_2, at: '2026-09-01T11:00:00.000Z', note: '' },
    ],
    payments: [
      {
        holder: HOLDER_Z,
        amount: '600.0000000000',
        paymentCid: 'cid-z',
        status: 'Paid',
        transferInstructionCid: null,
      },
      {
        holder: HOLDER_A,
        amount: '360.0000000000',
        paymentCid: 'cid-a',
        status: 'Paid',
        transferInstructionCid: null,
      },
      {
        holder: HOLDER_M,
        amount: '240.0000000000',
        paymentCid: 'cid-m',
        status: 'AwaitingAcceptance',
        transferInstructionCid: 'ti-m',
      },
    ],
    actor: AGENT,
    reason: null,
    at: '2026-09-01T12:00:00.000Z',
    seeded: false,
    ...overrides,
  };
}

const NAMES = new Map<string, string>([
  [HOLDER_Z, 'Zeta Capital'],
  [HOLDER_A, 'Alpha Partners'],
  [HOLDER_M, 'Mid Fund Ltd'],
  [APPROVER_1, 'Priya Shah'],
  [APPROVER_2, 'Tom Reed'],
]);

function context(
  evidence: readonly Evidence[],
  updates: Record<string, string> = {},
): EvidenceContext {
  const holderLabels = holderLabelsFor(evidence);
  const replacements = new Map<string, string>();
  for (const [p, label] of holderLabels) {
    replacements.set(p, label);
    const name = NAMES.get(p);
    if (name) replacements.set(name, label);
  }
  return {
    holderLabels,
    approverName: (p) => NAMES.get(p) ?? p,
    updateIdOf: (cid) => updates[cid] ?? null,
    linkFor: (updateId) => auditorTxLink({ network: 'localnet' }, updateId),
    redact: createRedactor(replacements),
  };
}

const D: Evidence = { tag: 'EvDecision', value: decision() };
const O: Evidence = { tag: 'EvOutcome', value: outcome() };

describe('holder labels', () => {
  it('count A to Z, then AA, AB', () => {
    expect([0, 1, 25, 26, 27, 51, 52].map(holderLabel)).toEqual([
      'Holder A',
      'Holder B',
      'Holder Z',
      'Holder AA',
      'Holder AB',
      'Holder AZ',
      'Holder BA',
    ]);
  });

  it('follow party-id order across the records of a grant and are stable for one holder', () => {
    const labels = holderLabelsFor([D, O]);
    // alpha < mid < zeta
    expect(labels.get(HOLDER_A)).toBe('Holder A');
    expect(labels.get(HOLDER_M)).toBe('Holder B');
    expect(labels.get(HOLDER_Z)).toBe('Holder C');
    // the order of the records does not change the labels
    expect([...holderLabelsFor([O, D])]).toEqual([...labels]);

    const ctx = context([D, O]);
    const decisionRecord = toEvidenceRecord(D, ctx).decision;
    const outcomeRecord = toEvidenceRecord(O, ctx).outcome;
    expect(decisionRecord?.payouts.map((p) => [p.holderLabel, p.amount])).toEqual([
      ['Holder A', '360.0000000000'],
      ['Holder B', '240.0000000000'],
      ['Holder C', '600.0000000000'],
    ]);
    expect(outcomeRecord?.payments.map((p) => [p.holderLabel, p.amount])).toEqual([
      ['Holder A', '360.0000000000'],
      ['Holder B', '240.0000000000'],
      ['Holder C', '600.0000000000'],
    ]);
  });

  it('contain no party id or hint of a holder', () => {
    const ctx = context([D, O], { 'cid-z': 'upd-1' });
    const json = JSON.stringify(toEvidenceRecords([D, O], ctx));
    for (const p of [HOLDER_A, HOLDER_M, HOLDER_Z]) {
      expect(json).not.toContain(p);
      expect(json).not.toContain(p.split('::')[0] ?? 'x');
    }
    expect(json).not.toContain(NS);
    for (const name of ['Zeta Capital', 'Alpha Partners', 'Mid Fund Ltd']) {
      expect(json).not.toContain(name);
    }
  });
});

describe('redactor', () => {
  it('replaces whole words in one pass, so a label is never replaced again', () => {
    const redact = createRedactor(
      new Map([
        ['Holder A', 'Holder B'],
        ['Holder B', 'Holder C'],
      ]),
    );
    expect(redact('Holder A paid, Holder B waited')).toBe('Holder B paid, Holder C waited');
    expect(redact('Holder AB is not Holder A')).toBe('Holder AB is not Holder B');
  });

  it('does nothing without replacements and escapes special characters', () => {
    expect(createRedactor(new Map())('Acme (Fund)')).toBe('Acme (Fund)');
    expect(createRedactor(new Map([['Acme (Fund)', 'Holder A']]))('Acme (Fund) paid')).toBe(
      'Holder A paid',
    );
  });
});

describe('decision evidence', () => {
  it('maps the record and keeps names out of the memo and the checks', () => {
    const ctx = context([D]);
    const record = toEvidenceRecord(D, ctx);
    expect(record).toMatchObject({
      recordId: 'decision/2026-09/1',
      kind: 'decision',
      cycleLabel: 'September 2026',
      outcome: null,
    });
    expect(record.decision).toMatchObject({
      trigger: 'Manual run: Run cycle now by Treasurer',
      recordDate: '2026-08-31',
      total: '1200.0000000000',
      verdict: 'needs-approval',
      mandateVersion: 1,
      cap: '5000.0000000000',
    });
    expect(record.decision?.memo).toBe('The largest payment is 600 CC to Holder C (50% of units).');
    expect(record.decision?.checks[0]).toMatchObject({
      actual: 'Holder B: 100 → 900 units (+800%)',
      passed: false,
      blocking: true,
      source: 'deterministic',
    });
    expect(record.decision?.inputFingerprints).toEqual([
      { label: 'register', sha256: 'a'.repeat(64) },
    ]);
    expect(record.decision?.modelFingerprints).toHaveLength(1);
  });

  it('maps AutoExecute to within-mandate', () => {
    const auto: Evidence = { tag: 'EvDecision', value: decision({ verdict: 'AutoExecute' }) };
    expect(toEvidenceRecord(auto, context([auto])).decision?.verdict).toBe('within-mandate');
  });
});

describe('outcome evidence', () => {
  it('labels approvers by display name and holders by label, with payment links', () => {
    const ctx = context([O], { 'cid-z': 'update-z', 'cid-a': 'update/a' });
    const record = toEvidenceRecord(O, ctx);
    expect(record.outcome?.kind).toBe('executed');
    expect(record.outcome?.approvals).toEqual([
      {
        approverLabel: 'Priya Shah',
        at: '2026-09-01T10:00:00.000Z',
        note: 'Checked the unit change',
      },
      { approverLabel: 'Tom Reed', at: '2026-09-01T11:00:00.000Z', note: '' },
    ]);
    const byLabel = new Map(record.outcome?.payments.map((p) => [p.holderLabel, p]));
    // alpha < mid < zeta
    expect(byLabel.get('Holder A')?.link).toEqual({
      updateId: 'update/a',
      href: '/auditor/tx/update%2Fa',
      external: false,
    });
    expect(byLabel.get('Holder C')?.link?.href).toBe('/auditor/tx/update-z');
    expect(byLabel.get('Holder B')).toMatchObject({ status: 'awaiting-acceptance', link: null });
    expect(byLabel.get('Holder A')?.status).toBe('paid');
  });

  it('keeps the reason of a rejection, redacted', () => {
    const rejected: Evidence = {
      tag: 'EvOutcome',
      value: outcome({
        kind: 'Rejected',
        reason: 'Zeta Capital jumped',
        payments: [],
        approvals: [],
      }),
    };
    const record = toEvidenceRecord(rejected, context([D, rejected]));
    expect(record.outcome).toMatchObject({
      kind: 'rejected',
      reason: 'Holder C jumped',
      payments: [],
    });
  });

  it('produces records the shared schema accepts', () => {
    const records = toEvidenceRecords([O, D], context([D, O]));
    expect(records.map((r) => r.recordId)).toEqual(['decision/2026-09/1', 'outcome/2026-09/1']);
    const room = EvidenceRoomSchema.parse({
      grantId: 'grant/audit-20261001-abc123',
      question: 'Q',
      grantedAt: '2026-10-01T00:00:00.000Z',
      expiresAt: '2026-10-08T00:00:00.000Z',
      records,
    });
    expect(room.records).toHaveLength(2);
  });
});

describe('payment links', () => {
  it('use the explorer on MainNet and the auditor page on LocalNet', () => {
    expect(auditorTxLink({ network: 'localnet' }, 'u1')).toEqual({
      updateId: 'u1',
      href: '/auditor/tx/u1',
      external: false,
    });
    expect(
      auditorTxLink(
        {
          network: 'mainnet',
          mainnet: {
            explorerTxUrl: 'https://explorer.example/tx/{updateId}',
            groftyMinVersion: '2',
          },
        } as never,
        'u1',
      ),
    ).toEqual({ updateId: 'u1', href: 'https://explorer.example/tx/u1', external: true });
  });
});

describe('treasurer previews', () => {
  it('summarize a flagged decision with its approvals', () => {
    const preview = previewDecision(decision(), outcome(), 'CC');
    expect(RecordPreviewSchema.parse(preview)).toEqual({
      recordId: 'decision/2026-09/1',
      kind: 'decision',
      label: 'Decision record, September 2026',
      summary: '1,200 CC to 3 holders, flagged, approved 2 of 3',
      available: true,
    });
  });

  it('summarize a clean decision without approvals', () => {
    const clean = decision({ verdict: 'AutoExecute', checks: [] });
    expect(previewDecision(clean, null, 'CC').summary).toBe(
      '1,200 CC to 3 holders, within mandate',
    );
  });

  it('count a failed blocking check as flagged even when the verdict says auto-execute', () => {
    const odd = decision({ verdict: 'AutoExecute' });
    expect(previewDecision(odd, null, 'CC').summary).toContain('flagged');
  });

  it('summarize outcomes: executed, rejected, cancelled', () => {
    expect(previewOutcome(outcome(), decision(), 'CC').summary).toBe(
      'Executed: 1,200 CC to 3 holders, flagged, approved 2 of 3',
    );
    expect(
      previewOutcome(
        outcome({ kind: 'Rejected', reason: 'Too high', approvals: [], payments: [] }),
        null,
        'CC',
      ).summary,
    ).toBe('Rejected: Too high');
    expect(
      previewOutcome(
        outcome({ kind: 'Cancelled', reason: null, approvals: [], payments: [] }),
        null,
        'CC',
      ).summary,
    ).toBe('Cancelled by the treasurer');
    expect(previewOutcome(outcome({ recordId: 'outcome/2026-09/2' }), decision(), 'CC').label).toBe(
      'Outcome, September 2026 (attempt 2)',
    );
  });

  it('say so when a record is gone', () => {
    expect(previewUnavailable({ recordId: 'decision/2026-01/1', kind: 'decision' })).toMatchObject({
      available: false,
      label: 'Decision record, January 2026',
    });
  });
});

describe('working-paper export', () => {
  it('lists the question, the grant dates, fields, fingerprints, approvals and payments', () => {
    const ctx = context([D, O], { 'cid-z': 'update-z' });
    const markdown = evidenceMarkdown(
      {
        grantId: 'grant/audit-20261001-abc123',
        question: 'Show all Q3 distributions',
        grantedAt: '2026-10-01T00:00:00.000Z',
        expiresAt: '2026-10-08T00:00:00.000Z',
        records: toEvidenceRecords([D, O], ctx),
      },
      'CC',
    );
    expect(markdown).toContain('# Mithra evidence summary');
    expect(markdown).toContain('Question: Show all Q3 distributions');
    expect(markdown).toContain('Access expires: 2026-10-08T00:00:00.000Z');
    expect(markdown).toContain('## Decision record, September 2026');
    expect(markdown).toContain('| Holder C | 500 | 600 CC |');
    expect(markdown).toContain('`' + 'a'.repeat(64) + '`');
    expect(markdown).toContain('- Priya Shah, 2026-09-01: Checked the unit change');
    expect(markdown).toContain('| Holder C | 600 CC | paid | /auditor/tx/update-z |');
    expect(markdown).toContain('| Holder B | 240 CC | awaiting-acceptance | n/a |');
    expect(markdown).not.toContain(NS);
    expect(markdown).not.toContain('Zeta Capital');
  });
});
