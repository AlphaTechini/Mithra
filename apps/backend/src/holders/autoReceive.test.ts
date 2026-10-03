import { describe, expect, it } from 'vitest';
import type { AssetAdapter, TransferKind } from '../wallet';
import { AutoReceiveStatus } from './autoReceive';

function adapter(kinds: Record<string, TransferKind | 'error'>) {
  const calls: string[] = [];
  const asset: AssetAdapter = {
    instrument: () => ({ admin: 'dso', id: 'CC' }),
    holdings: () => Promise.resolve([]),
    balance: () => Promise.resolve('0'),
    transferLeg(input) {
      calls.push(input.receiver);
      const kind = kinds[input.receiver] ?? 'offer';
      if (kind === 'error') return Promise.reject(new Error('registry down'));
      return Promise.resolve({
        kind,
        disclosed: [],
        leg: {
          holder: input.receiver,
          factoryCid: 'f',
          extraArgs: { context: { values: {} }, meta: { values: {} } },
        },
      });
    },
    acceptContext: () =>
      Promise.resolve({
        extraArgs: { context: { values: {} }, meta: { values: {} } },
        disclosed: [],
      }),
  };
  return { asset, calls };
}

describe('AutoReceiveStatus', () => {
  it('reads direct as on and offer as off, and caches for 60 s', async () => {
    let t = 0;
    const { asset, calls } = adapter({ a: 'direct', b: 'offer' });
    const status = new AutoReceiveStatus({ asset, treasury: 'treasury', now: () => t });
    expect(await status.getMany(['a', 'b'])).toEqual(
      new Map([
        ['a', true],
        ['b', false],
      ]),
    );
    t = 59_000;
    await status.get('a');
    expect(calls).toEqual(['a', 'b']);
    t = 60_001;
    await status.get('a');
    expect(calls).toEqual(['a', 'b', 'a']);
  });

  it('is null on error, reports it, and retries soon', async () => {
    let t = 0;
    const errors: string[] = [];
    const { asset, calls } = adapter({ a: 'error' });
    const status = new AutoReceiveStatus({
      asset,
      treasury: 'treasury',
      now: () => t,
      onError: (holder) => errors.push(holder),
    });
    expect(await status.get('a')).toBeNull();
    expect(errors).toEqual(['a']);
    t = 1000;
    await status.get('a');
    expect(calls).toHaveLength(1);
    t = 6000;
    await status.get('a');
    expect(calls).toHaveLength(2);
  });

  it('invalidate forces a fresh lookup and concurrent lookups share one call', async () => {
    const { asset, calls } = adapter({ a: 'direct' });
    const status = new AutoReceiveStatus({ asset, treasury: 'treasury' });
    await Promise.all([status.get('a'), status.get('a'), status.get('a')]);
    expect(calls).toHaveLength(1);
    status.invalidate('a');
    await status.get('a');
    expect(calls).toHaveLength(2);
  });

  it('discards a lookup in flight when invalidated: it is not shared and not cached', async () => {
    const answers: { resolve: (value: boolean) => void }[] = [];
    let asked = 0;
    const status = new AutoReceiveStatus({
      lookup: () => {
        asked += 1;
        return new Promise<boolean>((resolve) => answers.push({ resolve }));
      },
    });
    const old = status.get('a'); // starts lookup 1 (the old answer)
    status.invalidate('a');
    const fresh = status.get('a'); // must start lookup 2, not share lookup 1
    expect(asked).toBe(2);
    answers[0]?.resolve(false); // the old lookup resolves after invalidation
    expect(await old).toBe(false);
    // The old answer did not reach the cache, and the fresh lookup is still the one in flight.
    const again = status.get('a');
    expect(asked).toBe(2);
    answers[1]?.resolve(true);
    expect(await fresh).toBe(true);
    expect(await again).toBe(true);
    expect(await status.get('a')).toBe(true);
    expect(asked).toBe(2);
  });
});
