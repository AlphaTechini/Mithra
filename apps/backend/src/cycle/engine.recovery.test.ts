import type { TimelineStep } from '@mithra/shared';
import { describe, expect, it } from 'vitest';
import type { ActivityLog } from '../activity/log';
import type { Database } from '../db';
import type { CycleRunRow } from '../db/schema';
import { EventBus } from '../events/bus';
import type { Contract, Ledger, Transaction } from '../ledger';
import type { PartyNames } from '../parties/names';
import { localnetTestConfig } from '../testConfig';
import type { AssetAdapter } from '../wallet';
import { createCycleService } from './engine';
import type { PayoutRail, RailResult } from './rail';
import { CycleStore, type RunPatch, type RunStatus } from './store';

const CYCLE = '2026-09';

/** `cycle_runs` in memory; `failOnce` makes the next change to a status throw (a DB error). */
class MemoryStore extends CycleStore {
  rows: CycleRunRow[] = [];
  steps: TimelineStep[] = [];
  failOnce: RunStatus | null = null;
  /** Every write in order: timeline steps, row changes and (from `setup`) activity entries. */
  trace: string[] = [];

  constructor() {
    super({} as Database, 'treasury::1220aa');
  }

  override get(cycleId: string): Promise<CycleRunRow | null> {
    const row = this.rows.find((r) => r.cycleId === cycleId);
    return Promise.resolve(row ? { ...row } : null);
  }
  override list(): Promise<CycleRunRow[]> {
    return Promise.resolve(this.rows.map((r) => ({ ...r })));
  }
  override withStatus(statuses: readonly RunStatus[]): Promise<CycleRunRow[]> {
    return Promise.resolve(
      this.rows.filter((r) => statuses.includes(r.status)).map((r) => ({ ...r })),
    );
  }
  override transition(
    id: number,
    from: readonly RunStatus[],
    patch: RunPatch,
  ): Promise<CycleRunRow | null> {
    if (patch.status && patch.status === this.failOnce) {
      this.failOnce = null;
      return Promise.reject(new Error('connection terminated'));
    }
    const row = this.rows.find((r) => r.id === id);
    if (!row || !from.includes(row.status)) return Promise.resolve(null);
    this.trace.push(`row:${patch.status ?? ''}${patch.waitingForWallets ? '+wallets' : ''}`);
    Object.assign(row, patch, { updatedAt: new Date() });
    return Promise.resolve(row);
  }
  override patch(id: number, patch: RunPatch): Promise<CycleRunRow | null> {
    const row = this.rows.find((r) => r.id === id);
    if (row) Object.assign(row, patch);
    return Promise.resolve(row ?? null);
  }
  override addTimeline(_cycleId: string, step: TimelineStep): Promise<void> {
    this.steps.push(step);
    this.trace.push(`step:${step.id}:${step.status}`);
    return Promise.resolve();
  }
  override setTxRef(): Promise<void> {
    return Promise.resolve();
  }
  override txRefsOf(): Promise<Map<string, string>> {
    return Promise.resolve(new Map<string, string>());
  }
}

function runRow(status: RunStatus): CycleRunRow {
  return {
    id: 1,
    orgTreasury: 'treasury::1220aa',
    cycleId: CYCLE,
    status,
    startedAt: new Date('2026-10-01T09:00:00Z'),
    finishedAt: null,
    error: null,
    updatedAt: new Date('2026-10-01T09:00:00Z'),
    trigger: 'manual',
    triggerDetail: '',
    total: '100',
    recordDate: '2026-09-30',
    executesAt: null,
    held: false,
    waitingForWallets: false,
    fundsShortfall: null,
  };
}

const PROPOSAL = {
  contractId: 'prop1',
  createdAt: '2026-10-01T09:00:00Z',
  payload: {
    cycleId: CYCLE,
    proposalId: 'p1',
    verdict: 'AutoExecute',
    total: '100.0000000000',
    seeded: false,
    approvals: [],
    payouts: [{ holder: 'alice::1', units: '10', amount: '100.0000000000' }],
  },
} as unknown as Contract<never>;

const MANDATE = {
  contractId: 'mandate1',
  createdAt: '2026-09-01T00:00:00Z',
  payload: { terms: { approvers: [], approvalThreshold: 1 }, cycleAttempts: [] },
} as unknown as Contract<never>;

const OUTCOME = {
  contractId: 'outcome1',
  createdAt: '2026-10-01T09:01:00Z',
  offset: 42,
  payload: {
    cycleId: CYCLE,
    kind: 'Executed',
    at: '2026-10-01T09:01:00Z',
    seeded: false,
    payments: [
      { holder: 'alice::1', amount: '60.0000000000', paymentCid: 'pay1', status: 'Paid' },
      { holder: 'bob::1', amount: '40.0000000000', paymentCid: 'pay2', status: 'Paid' },
    ],
  },
} as unknown as Contract<never>;

const TX: Transaction = {
  updateId: 'upd-42',
  offset: 42,
  effectiveAt: '2026-10-01T09:01:00Z',
  recordTime: '2026-10-01T09:01:00Z',
  synchronizerId: 's',
  events: [],
};

function setup(rail: PayoutRail) {
  const store = new MemoryStore();
  store.rows.push(runRow('proposed'));
  const mandateState = { current: MANDATE };
  const ledgerState = { proposals: [PROPOSAL], outcomes: [] as Contract<never>[] };
  const reader = {
    mandate: () => Promise.resolve(mandateState.current),
    proposals: () => Promise.resolve(ledgerState.proposals),
    outcomes: () => Promise.resolve(ledgerState.outcomes),
    decisionRecords: () => Promise.resolve([]),
    payments: () => Promise.resolve([]),
  };
  const ledger = {
    reader,
    client: { updateByOffset: () => Promise.resolve(TX) },
    commands: {},
  } as unknown as Pick<Ledger, 'client' | 'reader' | 'commands'>;
  const activity: { kind: string; text: string }[] = [];
  const warnings: unknown[] = [];
  const cycles = createCycleService({
    config: localnetTestConfig(),
    db: {} as Database,
    ledger,
    assets: {} as AssetAdapter,
    names: {
      name: (p: string) => Promise.resolve(p),
      ref: (p: string) => Promise.resolve({ partyId: p, displayName: p }),
    } as unknown as PartyNames,
    activity: {
      record: (input: { kind: string; text: string }) => {
        activity.push(input);
        store.trace.push(`activity:${input.kind}`);
        return Promise.resolve({});
      },
    } as unknown as ActivityLog,
    bus: new EventBus(),
    rail,
    store,
    timers: false,
    log: { warn: (object: unknown) => warnings.push(object) },
  });
  return { cycles, store, ledgerState, activity, warnings, mandate: mandateState };
}

/** A rail that moves the money: the proposal is consumed and the outcome appears on the ledger. */
function payingRail(state: {
  proposals: Contract<never>[];
  outcomes: Contract<never>[];
}): PayoutRail {
  return {
    kind: 'ledger',
    run: () => {
      state.proposals = [];
      state.outcomes = [OUTCOME];
      return Promise.resolve({ kind: 'paid', tx: TX } satisfies RailResult);
    },
  };
}

describe('a bookkeeping failure after the ledger confirmed the payout', () => {
  it('does not mark the cycle failed or report the payout as failed; the next advance settles it', async () => {
    const holder = {
      state: null as unknown as { proposals: Contract<never>[]; outcomes: Contract<never>[] },
    };
    const rail: PayoutRail = {
      kind: 'ledger',
      run: (request, hooks) => payingRail(holder.state).run(request, hooks),
    };
    const { cycles, store, ledgerState, activity, warnings } = setup(rail);
    holder.state = ledgerState;
    store.failOnce = 'executed'; // the DB fails once while the paid result is being recorded

    expect(await cycles.advance(CYCLE)).toBe('retry');
    expect(store.rows[0]?.status).toBe('executing');
    expect(store.rows[0]?.error).toBeNull();
    expect(activity.some((a) => /did not go through/.test(a.text))).toBe(false);
    expect(activity.some((a) => a.kind === 'cycle.failed')).toBe(false);
    expect(store.steps.some((s) => s.status === 'failed')).toBe(false);
    expect(warnings).toHaveLength(1);

    // The next pass finds the outcome on the ledger and settles the row.
    expect(await cycles.advance(CYCLE)).toBe('executed');
    expect(store.rows[0]?.status).toBe('executed');
    expect(store.rows[0]?.error).toBeNull();
    expect(store.steps.at(-1)).toMatchObject({ id: 'execute', status: 'done' });
    expect(store.steps.at(-1)?.detail).toBe('Paid 100 CC to 1 holder');
    expect(activity.map((a) => a.kind)).toEqual(['payment.paid']);
    expect(activity.some((a) => /did not go through/.test(a.text))).toBe(false);
    // Nothing more to do afterwards.
    expect(await cycles.advance(CYCLE)).toBe('idle');
  });

  it('marks the row executed only after the timeline step and the activity entry are written', async () => {
    const holder = {
      state: null as unknown as { proposals: Contract<never>[]; outcomes: Contract<never>[] },
    };
    const rail: PayoutRail = {
      kind: 'ledger',
      run: (request, hooks) => payingRail(holder.state).run(request, hooks),
    };
    const { cycles, store, ledgerState } = setup(rail);
    holder.state = ledgerState;
    expect(await cycles.advance(CYCLE)).toBe('executed');
    // The ledger shows the payout as soon as the rail returns, so the row (which lets the cycle
    // show as paid) is the last write: a client that sees it paid finds the rest.
    expect(store.trace.filter((t) => !t.startsWith('step:execute:running'))).toEqual([
      'row:executing',
      'step:execute:done',
      'activity:payment.paid',
      'row:executed',
    ]);
  });

  it('records the wait for wallets before the row is marked as waiting', async () => {
    const { cycles, store } = setup({
      kind: 'grofty-mainnet',
      run: () =>
        Promise.resolve({ kind: 'needs-wallets', holders: ['alice::1'] } satisfies RailResult),
    });
    expect(await cycles.advance(CYCLE)).toBe('needs-wallets');
    expect(store.trace).toEqual([
      'row:executing',
      'step:execute:pending',
      'activity:cycle.needs-wallets',
      'row:proposed+wallets',
    ]);
    expect(store.rows[0]).toMatchObject({ status: 'proposed', waitingForWallets: true });
  });

  it('records the shortfall in the activity log before the row shows it', async () => {
    const { cycles, store } = setup({
      kind: 'ledger',
      run: () =>
        Promise.resolve({
          kind: 'needs-funds',
          balance: '10',
          required: '101',
        } satisfies RailResult),
    });
    expect(await cycles.advance(CYCLE)).toBe('needs-funds');
    expect(store.trace).toEqual(['row:executing', 'activity:cycle.needs-funds', 'row:proposed']);
    expect(store.rows[0]).toMatchObject({
      status: 'proposed',
      fundsShortfall: { balance: '10', required: '101' },
    });
  });

  it('does not run a cycle again that the Mandate already executed', async () => {
    const { cycles, store, mandate } = setup({
      kind: 'ledger',
      run: () => Promise.reject(new Error('must not run')),
    });
    store.rows[0] = runRow('executed');
    mandate.current = {
      ...MANDATE,
      payload: { ...(MANDATE.payload as object), executedCycles: [CYCLE] },
    } as unknown as Contract<never>;
    const input = { trigger: 'manual', triggerDetail: 'x', cycleId: CYCLE, total: '5' } as const;
    expect(await cycles.run({ ...input, actorParty: 'a' })).toEqual({ cycleId: CYCLE });
    await cycles.settled();
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.status).toBe('executed');
    expect(store.trace).toEqual([]);
  });

  it('settles a stale failed row of an executed cycle from the ledger instead of starting another attempt', async () => {
    const { cycles, store, mandate, ledgerState } = setup({
      kind: 'ledger',
      run: () => Promise.reject(new Error('must not run')),
    });
    store.rows[0] = runRow('failed');
    ledgerState.proposals = [];
    ledgerState.outcomes = [OUTCOME];
    mandate.current = {
      ...MANDATE,
      payload: { ...(MANDATE.payload as object), executedCycles: [CYCLE] },
    } as unknown as Contract<never>;
    await cycles.run({
      trigger: 'manual',
      triggerDetail: 'x',
      cycleId: CYCLE,
      total: '5',
      actorParty: 'a',
    });
    await cycles.settled();
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.status).toBe('executed');
  });

  it('lists an execution without a live run for the reconciler', async () => {
    const { cycles, store } = setup({ kind: 'ledger', run: () => Promise.reject(new Error('x')) });
    store.rows[0] = runRow('executing');
    expect(await cycles.waitingCycleIds()).toEqual([CYCLE]);
  });

  it('leaves an executing row alone while the ledger has no outcome, and recoverStale frees it later', async () => {
    const { cycles, store } = setup({ kind: 'ledger', run: () => Promise.reject(new Error('x')) });
    store.rows[0] = runRow('executing');
    expect(await cycles.advance(CYCLE)).toBe('idle');
    expect(store.rows[0]?.status).toBe('executing');
    await cycles.recoverStale(); // far past the stale limit: the clock of the row is old
    expect(store.rows[0]?.status).toBe('proposed');
  });

  it('still marks the cycle failed when the rail itself refuses the payout', async () => {
    const { cycles, store, activity } = setup({
      kind: 'ledger',
      run: () => Promise.reject(new Error('Mandate cap exceeded')),
    });
    expect(await cycles.advance(CYCLE)).toBe('failed');
    expect(store.rows[0]?.status).toBe('failed');
    expect(store.rows[0]?.error).toBe('Mandate cap exceeded');
    expect(activity.some((a) => /did not go through: Mandate cap exceeded/.test(a.text))).toBe(
      true,
    );
  });
});
