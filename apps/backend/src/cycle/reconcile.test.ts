import { describe, expect, it } from 'vitest';
import type { ActivityLog } from '../activity/log';
import type { Database } from '../db';
import { EventBus } from '../events/bus';
import type { MandateSealer } from '../governance/sealer';
import type { Ledger, Transaction } from '../ledger';
import type { PartyNames } from '../parties/names';
import { localnetTestConfig } from '../testConfig';
import type { CycleService } from './engine';
import { classifyArchive, createReconciler } from './reconcile';
import { CycleStore } from './store';

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

describe('the reconciler pass', () => {
  const markedTx: Transaction = {
    ...tx('Payment_MarkAccepted', 'pay'),
    updateId: 'mark-update',
    events: [
      {
        kind: 'exercised',
        contractId: 'pay',
        templateId: 'pkg:Mithra.Payment:Payment',
        entity: 'Mithra.Payment:Payment',
        choice: 'Payment_MarkAccepted',
        choiceArgument: {},
        exerciseResult: 'pay-paid',
        consuming: true,
        actingParties: ['agent'],
      },
    ],
  };

  function payment(id: string, cycleId: string) {
    return {
      contractId: id,
      createdAt: '2026-10-01T00:00:00Z',
      payload: {
        status: 'AwaitingAcceptance',
        transferInstructionCid: `ti-${id}`,
        cycleId,
        holder: 'alice::1',
        amount: '10.0000000000',
      },
    };
  }

  function setup(options: {
    payments?: ReturnType<typeof payment>[];
    store?: Partial<CycleStore>;
    activityFails?: boolean;
    sealer?: MandateSealer;
  }) {
    const payments = options.payments ?? [];
    const accepted: string[] = [];
    const activity: string[] = [];
    const warnings: unknown[] = [];
    const store = Object.assign(new CycleStore({} as Database, 'treasury'), {
      setTxRef: () => Promise.resolve(),
      ...options.store,
    });
    const acceptTx = tx('TransferInstruction_Accept', 'x');
    const ledger = {
      reader: { payments: () => Promise.resolve(payments) },
      client: {
        eventsByContractId: () => Promise.resolve({ archivedAtOffset: 5 }),
        updateByOffset: () =>
          Promise.resolve({
            ...acceptTx,
            events: acceptTx.events.map((e) => ({ ...e, contractId: lastInstruction.cid })),
          }),
        submit: ({ commands }: { commands: { id: string }[] }) => {
          accepted.push(commands[0]?.id ?? '');
          return Promise.resolve(markedTx);
        },
      },
      commands: { paymentMarkAccepted: (id: string) => ({ id }) },
    } as unknown as Pick<Ledger, 'client' | 'reader' | 'commands'>;
    // The fake archive transaction must name the instruction being looked up.
    const lastInstruction = { cid: '' };
    (
      ledger.client as unknown as { eventsByContractId: (cid: string) => Promise<unknown> }
    ).eventsByContractId = (cid: string) => {
      lastInstruction.cid = cid;
      return Promise.resolve({ archivedAtOffset: 5 });
    };
    const reconciler = createReconciler({
      config: localnetTestConfig(),
      db: {} as Database,
      ledger,
      cycles: {
        recoverStale: () => Promise.resolve(),
        waitingCycleIds: () => Promise.resolve([]),
        advance: () => Promise.resolve('idle'),
        getCycle: () => Promise.reject(new Error('not needed')),
      } as unknown as CycleService,
      names: { name: () => Promise.resolve('Alice') } as unknown as PartyNames,
      activity: {
        record: (input: { subject: string }) => {
          if (options.activityFails) return Promise.reject(new Error('activity db down'));
          activity.push(input.subject);
          return Promise.resolve({});
        },
      } as unknown as ActivityLog,
      bus: new EventBus(),
      store,
      log: { warn: (object: unknown) => warnings.push(object) },
      ...(options.sealer ? { sealer: options.sealer } : {}),
    });
    return { reconciler, accepted, activity, warnings };
  }

  it('logs a bookkeeping failure of an accepted payment and goes on with the next payment', async () => {
    const { reconciler, accepted, activity, warnings } = setup({
      payments: [payment('p1', '2026-07'), payment('p2', '2026-08')],
      store: {
        setTxRef: () => Promise.reject(new Error('connection terminated')),
      },
    });
    const report = await reconciler.reconcileOnce();
    expect(accepted).toEqual(['p1', 'p2']);
    expect(report.accepted).toEqual(['2026-07', '2026-08']);
    expect(activity).toEqual(['2026-07', '2026-08']);
    expect(warnings).toHaveLength(2);
  });

  it('logs an activity log failure of an accepted payment and goes on', async () => {
    const { reconciler, accepted, warnings } = setup({
      payments: [payment('p1', '2026-07'), payment('p2', '2026-08')],
      activityFails: true,
    });
    const report = await reconciler.reconcileOnce();
    expect(accepted).toEqual(['p1', 'p2']);
    expect(report.accepted).toEqual(['2026-07', '2026-08']);
    expect(warnings).toHaveLength(2);
  });

  it('lists only the seals whose advance succeeded', async () => {
    const sealer = {
      pending: () => Promise.resolve(['seal-ok', 'seal-bad', 'seal-ok-2']),
      advance: (id: string) =>
        id === 'seal-bad' ? Promise.reject(new Error('DecMan is down')) : Promise.resolve({}),
    } as unknown as MandateSealer;
    const { reconciler } = setup({ sealer });
    const report = await reconciler.reconcileOnce();
    expect(report.sealsAdvanced).toEqual(['seal-ok', 'seal-ok-2']);
  });
});
