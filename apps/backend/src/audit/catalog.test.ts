import { describe, expect, it } from 'vitest';
import type { Contract, DecisionRecord, DistributionOutcome } from '../ledger';
import {
  buildCatalog,
  compareRecordIds,
  createAuditCatalog,
  isFlagged,
  kindOfRecordId,
  labelForRecordId,
  parseRecordId,
} from './catalog';

const P = (hint: string): string => `${hint}::1220${'cd'.repeat(30)}`;

function decision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    recordId: 'decision/2026-09/1',
    treasury: P('treasury'),
    treasurer: P('treasurer'),
    agent: P('agent'),
    approvers: [P('approver1'), P('approver2')],
    cycleId: '2026-09',
    cycleLabel: 'September 2026',
    trigger: 'TriggerManual',
    triggerDetail: '',
    recordDate: '2026-08-31',
    total: '1200.0000000000',
    payouts: [{ holder: P('holder'), units: 1, amount: '1200.0000000000' }],
    inputFingerprints: [],
    checks: [],
    memo: '',
    memoSource: 'template',
    modelFingerprints: [],
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
    treasury: P('treasury'),
    treasurer: P('treasurer'),
    agent: P('agent'),
    approvers: [P('approver1'), P('approver2')],
    decisionRecordId: 'decision/2026-09/1',
    cycleId: '2026-09',
    cycleLabel: 'September 2026',
    kind: 'Executed',
    approvals: [],
    payments: [],
    actor: P('agent'),
    reason: null,
    at: '2026-09-01T12:00:00.000Z',
    seeded: false,
    ...overrides,
  };
}

const wrap = <T>(payload: T): Contract<T> => ({
  contractId: 'c',
  payload,
  createdAt: '2026-09-01T00:00:00Z',
});

describe('record ids', () => {
  it('are labelled by kind and cycle', () => {
    expect(labelForRecordId('decision/2026-09/1')).toBe('Decision record, September 2026');
    expect(labelForRecordId('outcome/2026-09/1')).toBe('Outcome, September 2026');
    expect(labelForRecordId('outcome/2026-09/2')).toBe('Outcome, September 2026 (attempt 2)');
    expect(labelForRecordId('something-else')).toBe('something-else');
  });

  it('are parsed and ordered by cycle, then decision before outcome, then attempt', () => {
    expect(parseRecordId('decision/2026-07/3')).toEqual({
      kind: 'decision',
      cycleId: '2026-07',
      attempt: 3,
    });
    expect(parseRecordId('x')).toBeNull();
    expect(kindOfRecordId('outcome/2026-07/1')).toBe('outcome');
    expect(kindOfRecordId('nope')).toBeNull();
    const ids = [
      'outcome/2026-09/1',
      'decision/2026-09/2',
      'decision/2026-09/1',
      'outcome/2026-07/1',
      'decision/2026-07/1',
    ];
    expect([...ids].sort(compareRecordIds)).toEqual([
      'decision/2026-07/1',
      'outcome/2026-07/1',
      'decision/2026-09/1',
      'decision/2026-09/2',
      'outcome/2026-09/1',
    ]);
  });
});

describe('flagged', () => {
  it('is NeedsApproval or any failed blocking check', () => {
    expect(isFlagged(decision({ verdict: 'NeedsApproval', checks: [] }))).toBe(true);
    expect(isFlagged(decision({ verdict: 'AutoExecute', checks: [] }))).toBe(false);
    const check = (passed: boolean, blocking: boolean) => ({
      code: 'c',
      label: 'l',
      passed,
      blocking,
      actual: '',
      limit: '',
      source: 'deterministic',
    });
    expect(isFlagged(decision({ verdict: 'AutoExecute', checks: [check(false, true)] }))).toBe(
      true,
    );
    expect(isFlagged(decision({ verdict: 'AutoExecute', checks: [check(false, false)] }))).toBe(
      false,
    );
    expect(isFlagged(decision({ verdict: 'AutoExecute', checks: [check(true, true)] }))).toBe(
      false,
    );
  });
});

describe('catalog', () => {
  const clean: DecisionRecord = decision({
    recordId: 'decision/2026-07/1',
    cycleId: '2026-07',
    cycleLabel: 'July 2026',
    verdict: 'AutoExecute',
    checks: [],
  });
  const cleanOutcome: DistributionOutcome = outcome({
    recordId: 'outcome/2026-07/1',
    decisionRecordId: 'decision/2026-07/1',
    cycleId: '2026-07',
    cycleLabel: 'July 2026',
    at: '2026-08-01T09:05:00.000Z',
  });
  const flagged = decision();
  const flaggedOutcome = outcome({ at: '2026-10-01T09:00:00.000Z' });
  const rejected = outcome({
    recordId: 'outcome/2026-09/2',
    decisionRecordId: 'decision/2026-09/2',
    kind: 'Rejected',
    reason: 'no',
  });

  it('lists decisions and outcomes with the flag of the decision and the execution time', () => {
    const entries = buildCatalog(
      [wrap(flagged), wrap(clean)],
      [wrap(flaggedOutcome), wrap(cleanOutcome), wrap(rejected)],
    );
    expect(entries.map((e) => [e.recordId, e.flagged, e.executedAt])).toEqual([
      ['decision/2026-07/1', false, '2026-08-01T09:05:00.000Z'],
      ['outcome/2026-07/1', false, '2026-08-01T09:05:00.000Z'],
      ['decision/2026-09/1', true, '2026-10-01T09:00:00.000Z'],
      ['outcome/2026-09/1', true, '2026-10-01T09:00:00.000Z'],
      // the decision of the rejected attempt is not in the list: its outcome is unflagged and not executed
      ['outcome/2026-09/2', false, null],
    ]);
    expect(entries[0]).toMatchObject({
      kind: 'decision',
      cycleId: '2026-07',
      cycleLabel: 'July 2026',
    });
  });

  it('reads the ledger through the reader and exposes labelFor', async () => {
    const catalog = createAuditCatalog({
      ledger: {
        reader: {
          decisionRecords: () => Promise.resolve([wrap(flagged)]),
          outcomes: () => Promise.resolve([wrap(flaggedOutcome)]),
        } as never,
      },
    });
    expect((await catalog()).map((e) => e.recordId)).toEqual([
      'decision/2026-09/1',
      'outcome/2026-09/1',
    ]);
    expect(catalog.labelFor('outcome/2026-09/1')).toBe('Outcome, September 2026');
  });
});
