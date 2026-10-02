import { describe, expect, it, vi } from 'vitest';
import { SeedError, ensureCycle, type SeedContext } from '../../../../scripts/seed/steps';

/**
 * The seeding step for one demo cycle (scripts/seed/steps.ts) against a stub cycle service: which
 * statuses skip, which start a run, which are polled to completion and which stop the seeding.
 */

type Status =
  | 'running'
  | 'countdown'
  | 'executing'
  | 'awaiting-approval'
  | 'needs-funds'
  | 'rejected'
  | 'cancelled'
  | 'failed'
  | 'paid-automatically'
  | 'paid-after-approval'
  | 'awaiting-acceptance';

/** A cycle service whose cycle is in `first`, and moves to the next status of `then` on each `advance`. */
function stub(first: Status | null, then: Status[] = [], error: string | null = null) {
  let current: Status | null = first;
  const queue = [...then];
  const run = vi.fn(() => {
    current = 'running';
    return Promise.resolve({ cycleId: '2026-06' });
  });
  const advance = vi.fn(() => {
    const next = queue.shift();
    if (next) current = next;
    return Promise.resolve('waiting');
  });
  const cycles = {
    listCycles: () =>
      Promise.resolve(current === null ? [] : [{ cycleId: '2026-06', status: current }]),
    getCycle: () => Promise.resolve({ summary: { status: current }, error }),
    run,
    advance,
  };
  const ctx = {
    backend: { config: { asset: { symbol: 'CC' } }, cycle: { cycles } },
    print: () => undefined,
    pollMs: 1,
    cycleTimeoutMs: 2_000,
  } as unknown as SeedContext;
  return { ctx, run, advance };
}

const demo = { cycleId: '2026-06', total: '400' };

describe('ensureCycle', () => {
  it.each(['paid-automatically', 'paid-after-approval', 'awaiting-acceptance'] as const)(
    'skips a cycle that is %s',
    async (status) => {
      const { ctx, run, advance } = stub(status);
      const result = await ensureCycle(ctx, demo, 'treasurer');
      expect(result).toEqual({ outcome: 'skipped', text: `already done (${status})` });
      expect(run).not.toHaveBeenCalled();
      expect(advance).not.toHaveBeenCalled();
    },
  );

  it('starts a run when there is no cycle, and polls it to completion', async () => {
    const { ctx, run } = stub(null, ['countdown', 'awaiting-acceptance']);
    const result = await ensureCycle(ctx, demo, 'treasurer');
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ cycleId: '2026-06', total: '400', seeded: true }),
    );
    expect(result).toEqual({ outcome: 'done', text: 'ran 400 CC, awaiting-acceptance, seeded' });
  });

  it('runs a failed cycle again', async () => {
    const { ctx, run } = stub('failed', ['paid-automatically']);
    const result = await ensureCycle(ctx, demo, 'treasurer');
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('done');
    expect(result.text).toMatch(/^ran 400 CC/);
  });

  it.each(['running', 'countdown', 'executing'] as const)(
    'finishes a cycle that is %s without starting a new run',
    async (status) => {
      const { ctx, run, advance } = stub(status, ['executing', 'paid-automatically']);
      const result = await ensureCycle(ctx, demo, 'treasurer');
      expect(run).not.toHaveBeenCalled();
      expect(advance).toHaveBeenCalled();
      expect(result).toEqual({
        outcome: 'done',
        text: 'finished 400 CC, paid-automatically, seeded',
      });
    },
  );

  it.each(['rejected', 'cancelled', 'needs-funds', 'awaiting-approval'] as const)(
    'stops with a SeedError for a cycle that is %s, and starts nothing',
    async (status) => {
      const { ctx, run, advance } = stub(status, [], 'Nobody can pay this');
      const failure = await ensureCycle(ctx, demo, 'treasurer').catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(SeedError);
      expect((failure as SeedError).message).toBe(
        `Cycle 2026-06 stopped at "${status}": Nobody can pay this. Fix that and seed again.`,
      );
      expect(run).not.toHaveBeenCalled();
      expect(advance).not.toHaveBeenCalled();
    },
  );

  it('gives up with a SeedError when a cycle under way does not finish in time', async () => {
    const { ctx, run } = stub('countdown');
    const failure = await ensureCycle({ ...ctx, cycleTimeoutMs: 30 }, demo, 'treasurer').catch(
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(SeedError);
    expect((failure as SeedError).message).toBe(
      'Cycle 2026-06 did not execute in time (status "countdown").',
    );
    expect(run).not.toHaveBeenCalled();
  });
});
