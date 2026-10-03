import type { RecordMainnetPayoutRequest } from '@mithra/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ActivityLog } from '../activity/log';
import type { Config } from '../config/env';
import type { CycleService } from '../cycle/engine';
import type { Database } from '../db';
import type { EventBus } from '../events/bus';
import type { Contract, Ledger, Payment } from '../ledger';
import type { PartyNames } from '../parties/names';
import { MainnetPayouts } from './payouts';

const TREASURY = 'treasury::1';
const AGENT = 'agent::1';
const CYCLE = '2026-09';

function payment(
  holder: string,
  contractId: string,
  overrides: Partial<Payment> = {},
): Contract<Payment> {
  return {
    contractId,
    createdAt: '2026-10-01T00:00:00Z',
    payload: {
      holder,
      cycleId: CYCLE,
      cycleLabel: 'September 2026',
      amount: '100.0000000000',
      externalReceiver: `${holder}-mainnet`,
      externalTxRef: null,
      status: 'PendingExternal',
      seeded: false,
      ...overrides,
    } as Payment,
  };
}

/**
 * A ledger that holds payments: recording archives the contract and creates a new one that
 * carries the update id, as `Payment_RecordExternal` does.
 */
function setup() {
  let payments = [payment('h1', 'cid-h1-0'), payment('h2', 'cid-h2-0')];
  /** When set, the next read answers with this (a read that is behind the ledger), once. */
  let staleOnce: Contract<Payment>[] | null = null;
  let counter = 0;
  const submitted: { cid: string; txRef: string }[] = [];
  const ledger = {
    reader: {
      payments: () => {
        const answer = staleOnce ?? payments;
        staleOnce = null;
        return Promise.resolve([...answer]);
      },
      mandate: () => Promise.resolve(null),
      organization: () => Promise.resolve(null),
      outcomes: () => Promise.resolve([]),
    },
    commands: {
      paymentRecordExternal: (cid: string, args: { txRef: string; status: string }) => ({
        cid,
        ...args,
      }),
    },
    client: {
      submit: (input: { commands: { cid: string; txRef: string; status: string }[] }) => {
        const command = input.commands[0];
        const old = payments.find((p) => p.contractId === command?.cid);
        if (!command || !old) return Promise.reject(new Error('CONTRACT_NOT_FOUND'));
        counter += 1;
        const next = payment(old.payload.holder, `cid-${old.payload.holder}-${counter}`, {
          externalTxRef: command.txRef,
          status: command.status as Payment['status'],
        });
        payments = payments.map((p) => (p.contractId === old.contractId ? next : p));
        submitted.push({ cid: old.contractId, txRef: command.txRef });
        return Promise.resolve({
          updateId: 'u',
          offset: counter,
          effectiveAt: '',
          recordTime: '',
          synchronizerId: '',
          events: [
            {
              kind: 'exercised',
              contractId: old.contractId,
              templateId: 'pkg:M:Payment',
              entity: 'M:Payment',
              choice: 'Payment_RecordExternal',
              choiceArgument: {},
              exerciseResult: next.contractId,
              consuming: true,
              actingParties: [AGENT],
            },
          ],
        });
      },
    },
  };
  const warnings: string[] = [];
  const payouts = new MainnetPayouts({
    config: {
      network: 'mainnet',
      parties: { treasury: TREASURY, agent: AGENT },
      asset: { symbol: 'CC' },
      ledger: { readAsTreasury: false },
    } as unknown as Config,
    db: {} as Database,
    ledger: ledger as unknown as Pick<Ledger, 'client' | 'reader' | 'commands'>,
    names: {
      name: (id: string) => Promise.resolve(id),
      ref: (id: string) => Promise.resolve({ partyId: id, displayName: id }),
    } as unknown as PartyNames,
    activity: { record: () => Promise.resolve({}) } as unknown as ActivityLog,
    bus: { publish: () => undefined } as unknown as EventBus,
    cycles: {
      getCycle: () => Promise.resolve({ summary: { status: 'executing', label: 'Sep' } }),
    } as unknown as Pick<CycleService, 'getCycle'>,
    log: { warn: (_object: unknown, message?: string) => void warnings.push(message ?? '') },
  });
  const txRefs: { cid: string; updateId: string }[] = [];
  const store = {
    setTxRef: vi.fn((cid: string, updateId: string) => {
      txRefs.push({ cid, updateId });
      return Promise.resolve();
    }),
    addTimeline: vi.fn(() => Promise.resolve()),
  };
  Object.assign(payouts['store'], store);
  return {
    payouts,
    store,
    submitted,
    txRefs,
    warnings,
    readBehindOnce: (snapshot: Contract<Payment>[]): void => {
      staleOnce = snapshot;
    },
    current: () => payments,
  };
}

const body = (updateId: string): RecordMainnetPayoutRequest => ({
  updateId,
  outcome: 'completed',
});

describe('MainnetPayouts.record is retry-safe', () => {
  it('logs, and does not fail, when saving the tx ref fails after the ledger write', async () => {
    const t = setup();
    t.store.setTxRef.mockRejectedValueOnce(new Error('database down'));
    const paymentId = t.payouts.paymentIdOf(CYCLE, 'h1');
    const reply = await t.payouts.record(CYCLE, paymentId, body('upd-1'), 'treasurer::1');
    expect(reply.payouts.find((p) => p.paymentId === paymentId)?.status).toBe('paid');
    expect(t.submitted).toEqual([{ cid: 'cid-h1-0', txRef: 'upd-1' }]);
    expect(t.warnings.some((w) => w.includes('could not be saved'))).toBe(true);
  });

  it('a retry with the same update id succeeds, submits nothing and repairs the tx ref', async () => {
    const t = setup();
    t.store.setTxRef.mockRejectedValueOnce(new Error('database down'));
    const paymentId = t.payouts.paymentIdOf(CYCLE, 'h1');
    await t.payouts.record(CYCLE, paymentId, body('upd-1'), 'treasurer::1');
    const retry = await t.payouts.record(CYCLE, paymentId, body('upd-1'), 'treasurer::1');
    expect(retry.payouts.find((p) => p.paymentId === paymentId)?.status).toBe('paid');
    expect(t.submitted).toHaveLength(1);
    // The first save failed; the retry saved it on the payment the ledger now holds.
    expect(t.txRefs).toEqual([{ cid: 'cid-h1-1', updateId: 'upd-1' }]);
  });

  it('still refuses a different update id for a payment that is already paid', async () => {
    const t = setup();
    const paymentId = t.payouts.paymentIdOf(CYCLE, 'h1');
    await t.payouts.record(CYCLE, paymentId, body('upd-1'), 'treasurer::1');
    await expect(
      t.payouts.record(CYCLE, paymentId, body('upd-2'), 'treasurer::1'),
    ).rejects.toMatchObject({ code: 'already_recorded' });
  });

  it('treats a rejected submit as done when the ledger already recorded that update id', async () => {
    const t = setup();
    const paymentId = t.payouts.paymentIdOf(CYCLE, 'h1');
    const before = t.current();
    await t.payouts.record(CYCLE, paymentId, body('upd-1'), 'treasurer::1');
    // The retry reads the archived contract (still PendingExternal): its submit finds no such
    // contract, the ledger is read again, and the payment recorded under this update id is there.
    t.readBehindOnce(before);
    const retry = await t.payouts.record(CYCLE, paymentId, body('upd-1'), 'treasurer::1');
    expect(retry.payouts.find((p) => p.paymentId === paymentId)?.status).toBe('paid');
    expect(t.submitted).toHaveLength(1);
    expect(t.txRefs.at(-1)).toEqual({ cid: 'cid-h1-1', updateId: 'upd-1' });
  });
});
