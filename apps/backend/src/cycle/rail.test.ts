import { describe, expect, it } from 'vitest';
import type { Contract, Ledger, Mandate, Proposal, Transaction } from '../ledger';
import { createMithraCommands, mithraTemplateIds } from '../ledger';
import type { AssetAdapter } from '../wallet';
import type { ExecuteRequest } from './executor';
import { GroftyMainnetRail, LedgerPayoutRail, type RailHooks } from './rail';

const H = (n: string): string => `${n}::1220aa`;
const commands = createMithraCommands(mithraTemplateIds('#mithra-v1'));
const direct = <T>(fn: () => Promise<T>): Promise<T> => fn();
const hooks = (): RailHooks & { announced: number } => {
  const h = {
    announced: 0,
    announce: () => {
      h.announced += 1;
      return Promise.resolve();
    },
  };
  return h;
};

const proposal = {
  contractId: 'proposal-cid',
  createdAt: '2026-10-01T09:00:00Z',
  payload: {
    proposalId: 'proposal/2026-09/1',
    cycleId: '2026-09',
    total: '300.0000000000',
    payouts: [
      { holder: H('a'), units: 100, amount: '100.0000000000' },
      { holder: H('b'), units: 200, amount: '200.0000000000' },
    ],
  },
} as unknown as Contract<Proposal>;
const mandate = {
  contractId: 'mandate-cid',
  createdAt: '2026-09-01T00:00:00Z',
  payload: { terms: { feeBuffer: '1.0000000000' } },
} as unknown as Contract<Mandate>;
const request = { cycleId: '2026-09', label: 'September 2026', proposal, mandate };
const tx = { updateId: 'upd-1', events: [] } as unknown as Transaction;

describe('GroftyMainnetRail status mapping', () => {
  it('records completed and unknown as Paid, pending as AwaitingAcceptance', () => {
    expect(GroftyMainnetRail.recordedStatus('completed')).toBe('Paid');
    expect(GroftyMainnetRail.recordedStatus('unknown')).toBe('Paid');
    expect(GroftyMainnetRail.recordedStatus('pending')).toBe('AwaitingAcceptance');
  });

  it('shows ledger payment statuses as payout statuses', () => {
    expect(GroftyMainnetRail.payoutStatus('PendingExternal')).toBe('to-sign');
    expect(GroftyMainnetRail.payoutStatus('AwaitingAcceptance')).toBe('awaiting-acceptance');
    expect(GroftyMainnetRail.payoutStatus('Paid')).toBe('paid');
  });
});

describe('GroftyMainnetRail', () => {
  const submits: unknown[] = [];
  const ledger = {
    client: {
      submit: (arg: unknown) => {
        submits.push(arg);
        return Promise.resolve(tx);
      },
    },
    commands,
  } as unknown as Pick<Ledger, 'client' | 'commands'>;
  const rail = (wallets: Map<string, string>) =>
    new GroftyMainnetRail({
      ledger,
      agent: H('agent'),
      readAs: [H('treasury')],
      wallets: { all: () => Promise.resolve(wallets) },
      lock: direct,
    });

  it('needs wallets, naming the holders without one, and submits nothing', async () => {
    submits.length = 0;
    const h = hooks();
    const result = await rail(new Map([[H('a'), 'a-main::1220ff']])).run(request, h);
    expect(result).toEqual({ kind: 'needs-wallets', holders: [H('b')] });
    expect(submits).toEqual([]);
    expect(h.announced).toBe(0);
    expect(await rail(new Map()).run(request, hooks())).toEqual({
      kind: 'needs-wallets',
      holders: [H('a'), H('b')],
    });
  });

  it("authorizes as the agent with every payee's MainNet party, in payout order, and moves no money", async () => {
    submits.length = 0;
    const h = hooks();
    const result = await rail(
      new Map([
        [H('b'), 'b-main::1220bb'],
        [H('a'), 'a-main::1220aa'],
        [H('zed'), 'unrelated::1220cc'],
      ]),
    ).run(request, h);
    expect(result).toEqual({ kind: 'authorized', tx });
    expect(h.announced).toBe(1);
    expect(submits).toHaveLength(1);
    expect(submits[0]).toMatchObject({
      actAs: [H('agent')],
      readAs: [H('treasury')],
      commandId: 'authorize-proposal/2026-09/1',
      shape: 'LEDGER_EFFECTS',
      commands: [
        {
          ExerciseCommand: {
            contractId: 'mandate-cid',
            choice: 'Mandate_AuthorizeExternalPayout',
            choiceArgument: {
              proposalCid: 'proposal-cid',
              receivers: [
                { _1: H('a'), _2: 'a-main::1220aa' },
                { _1: H('b'), _2: 'b-main::1220bb' },
              ],
            },
          },
        },
      ],
    });
  });
});

describe('LedgerPayoutRail', () => {
  const executed: ExecuteRequest[] = [];
  const makeRail = (balance: string) => {
    executed.length = 0;
    const assets = {
      balance: () => Promise.resolve(balance),
      holdings: () =>
        Promise.resolve([
          { contractId: 'h1', amount: '500', locked: false },
          { contractId: 'h2', amount: '50', locked: true },
        ]),
      transferLeg: (input: { receiver: string }) =>
        Promise.resolve({ leg: { holder: input.receiver }, disclosed: [], kind: 'direct' }),
    } as unknown as AssetAdapter;
    return new LedgerPayoutRail({
      assets,
      executor: {
        execute: (r) => {
          executed.push(r);
          return Promise.resolve(tx);
        },
      },
      treasury: H('treasury'),
      executeWindowMs: 600_000,
      now: () => new Date('2026-10-01T12:00:00Z'),
      lock: direct,
    });
  };

  it('P5: blocks when the balance is below the total plus the fee buffer, before announcing', async () => {
    const h = hooks();
    const result = await makeRail('300.5').run(request, h);
    expect(result).toEqual({
      kind: 'needs-funds',
      balance: '300.5000000000',
      required: '301.0000000000',
    });
    expect(h.announced).toBe(0);
    expect(executed).toEqual([]);
  });

  it('pays through the ledger when the balance covers it (unchanged behavior)', async () => {
    const h = hooks();
    const result = await makeRail('301').run(request, h);
    expect(result).toEqual({ kind: 'paid', tx });
    expect(h.announced).toBe(1);
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({
      mandateCid: 'mandate-cid',
      proposalCid: 'proposal-cid',
      inputHoldingCids: ['h1'],
      commandId: 'execute-proposal/2026-09/1',
      executeBefore: new Date('2026-10-01T12:10:00Z'),
    });
    expect(executed[0]?.legs.map((l) => l.holder)).toEqual([H('a'), H('b')]);
  });
});
