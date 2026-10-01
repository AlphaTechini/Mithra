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
});
