import { ShowcaseSchema, type CycleDetail, type CycleSummary } from '@mithra/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildShowcase, showcaseRoute, type ShowcaseSource } from './showcase';

const HOLDERS = [
  { displayName: 'Holder A', partyId: 'holderA::1220aaaa', amount: '49.9999999999' },
  { displayName: 'Holder B', partyId: 'holderB::1220bbbb', amount: '150.0000000001' },
  { displayName: 'Holder C', partyId: 'holderC::1220cccc', amount: '700.0000000000' },
  { displayName: 'Northwind Treasurer', partyId: 'treasurer::1220dddd', amount: '300.0000000000' },
];

function summary(over: Partial<CycleSummary>): CycleSummary {
  return {
    cycleId: '2026-09',
    label: 'September 2026',
    status: 'paid-after-approval',
    total: '1200.0000000000',
    recordDate: '2026-08-31',
    approvals: { have: 2, need: 2 },
    flagCount: 2,
    trigger: 'prompt',
    createdAt: '2026-10-01T10:00:00.000Z',
    seeded: false,
    ...over,
  };
}

/** A detail that is full of private data, to prove the showcase leaves all of it out. */
function detail(s: CycleSummary): CycleDetail {
  return {
    summary: s,
    timeline: [],
    proposal: {
      proposalId: 'proposal-1',
      total: s.total ?? '0',
      recordDate: '2026-08-31',
      verdict: 'needs-approval',
      verdictReasons: [],
      payouts: HOLDERS.map((h) => ({
        holder: { partyId: h.partyId, displayName: h.displayName },
        units: 100,
        sharePct: '25.00',
        amount: h.amount,
        payment: null,
      })),
      checks: [],
      memo: 'Holder C bought 900 units before the record date.',
      memoSource: 'ai',
      approvals: [],
      approvalThreshold: 2,
      approvers: [1, 2, 3].map((n) => ({
        partyId: `approver${n}::1220eeee`,
        displayName: `Approver ${n}`,
      })),
      decisionRecordId: 'record-1',
    },
    decisionRecord: null,
    countdown: null,
    outcome: null,
    fundsShortfall: null,
    error: null,
  } as unknown as CycleDetail;
}

function source(cycles: CycleSummary[]): ShowcaseSource & { reads: number } {
  const counter = {
    reads: 0,
    listCycles() {
      counter.reads += 1;
      return Promise.resolve(cycles);
    },
    getCycle(cycleId: string) {
      const found = cycles.find((c) => c.cycleId === cycleId);
      return found ? Promise.resolve(detail(found)) : Promise.reject(new Error('no such cycle'));
    },
  };
  return counter;
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('buildShowcase', () => {
  it('describes the latest executed cycle that was approved: label, total, payees, approvals', async () => {
    const showcase = await buildShowcase(
      source([
        summary({ cycleId: '2026-09', createdAt: '2026-10-01T10:00:00.000Z' }),
        summary({
          cycleId: '2026-08',
          label: 'August 2026',
          status: 'paid-automatically',
          approvals: null,
          total: '300.0000000000',
          createdAt: '2026-09-01T10:00:00.000Z',
        }),
      ]),
      'CC',
    );
    expect(showcase).toEqual({
      cycleLabel: 'September 2026',
      total: '1200.0000000000',
      assetSymbol: 'CC',
      payees: 4,
      approvals: { have: 2, need: 2, approvers: 3 },
    });
  });

  it('is null when no cycle was approved and executed (clean, waiting, rejected, failed)', async () => {
    const showcase = await buildShowcase(
      source([
        summary({ status: 'paid-automatically', approvals: null }),
        summary({
          cycleId: '2026-07',
          status: 'awaiting-approval',
          approvals: { have: 1, need: 2 },
        }),
        summary({ cycleId: '2026-06', status: 'rejected' }),
        summary({ cycleId: '2026-05', status: 'failed' }),
        summary({ cycleId: '2026-04', status: 'executing', approvals: { have: 2, need: 2 } }),
      ]),
      'CC',
    );
    expect(showcase).toBeNull();
  });

  it('counts a cycle whose payments still wait for a holder as executed', async () => {
    const showcase = await buildShowcase(
      source([summary({ status: 'awaiting-acceptance' })]),
      'CC',
    );
    expect(showcase?.cycleLabel).toBe('September 2026');
  });
});

describe('GET /api/public/showcase', () => {
  async function get(cycles: CycleSummary[]) {
    app = Fastify();
    showcaseRoute(app, { cycles: source(cycles), assetSymbol: 'CC' });
    return app.inject({ method: 'GET', url: '/api/public/showcase' });
  }

  it('answers without any session and returns only aggregate numbers', async () => {
    const res = await get([summary({})]);
    expect(res.statusCode).toBe(200);
    expect(ShowcaseSchema.parse(res.json())).toMatchObject({ payees: 4, total: '1200.0000000000' });
    expect(Object.keys(res.json<object>()).sort()).toEqual([
      'approvals',
      'assetSymbol',
      'cycleLabel',
      'payees',
      'total',
    ]);
  });

  it('contains no party id, holder name or per-holder amount, in any form', async () => {
    const res = await get([summary({})]);
    const body = res.body;
    for (const holder of HOLDERS) {
      expect(body).not.toContain(holder.displayName);
      expect(body).not.toContain(holder.partyId);
      expect(body).not.toContain(holder.partyId.split('::')[0] ?? '#');
      expect(body).not.toContain(holder.amount);
    }
    for (const word of [
      'Holder',
      'Approver 1',
      'approver1',
      'memo',
      'units',
      '1220',
      '::',
      'treasurer',
      'proposal-1',
    ]) {
      expect(body.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it('answers null while there is no approved cycle', async () => {
    const res = await get([summary({ status: 'paid-automatically', approvals: null })]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();
  });

  it('reuses its answer for a short while instead of reading the ledger for every visitor', async () => {
    const src = source([summary({})]);
    let clock = 1_000;
    app = Fastify();
    showcaseRoute(app, { cycles: src, assetSymbol: 'CC', now: () => clock, cacheMs: 15_000 });
    await app.inject({ method: 'GET', url: '/api/public/showcase' });
    await app.inject({ method: 'GET', url: '/api/public/showcase' });
    expect(src.reads).toBe(1);
    clock += 16_000;
    await app.inject({ method: 'GET', url: '/api/public/showcase' });
    expect(src.reads).toBe(2);
  });
});
