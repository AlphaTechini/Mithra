import { describe, expect, it } from 'vitest';
import type { Transaction } from '../ledger';
import { classifyArchive } from './reconcile';

function tx(choice: string, contractId = 'ti1'): Transaction {
  return {
    updateId: 'upd1',
    offset: 7,
    effectiveAt: '2026-10-01T12:00:00Z',
    recordTime: '2026-10-01T12:00:00Z',
    synchronizerId: 's',
    events: [
      {
        kind: 'exercised',
        contractId,
        templateId: 'pkg:Splice.Test:Instruction',
        entity: 'Splice.Test:Instruction',
        choice,
        choiceArgument: {},
        exerciseResult: {},
        consuming: true,
        actingParties: ['holder'],
      },
    ],
  };
}

describe('classifyArchive: how a pending transfer ended', () => {
  it.each([
    ['TransferInstruction_Accept', 'accepted'],
    ['TransferInstruction_Reject', 'rejected'],
    ['TransferInstruction_Withdraw', 'withdrawn'],
    ['TransferInstruction_Update', 'updated'],
    ['Something_Else', 'unknown'],
  ])('%s is %s', (choice, reason) => {
    expect(classifyArchive(tx(choice), 'ti1')).toEqual({ reason, updateId: 'upd1' });
  });

  it('ignores exercises of other contracts', () => {
    expect(classifyArchive(tx('TransferInstruction_Accept', 'other'), 'ti1').reason).toBe(
      'unknown',
    );
  });

  it('ignores non-consuming exercises', () => {
    const t = tx('TransferInstruction_Accept');
    const [event] = t.events;
    if (event?.kind === 'exercised') event.consuming = false;
    expect(classifyArchive(t, 'ti1').reason).toBe('unknown');
  });
});
