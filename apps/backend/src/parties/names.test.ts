import { describe, expect, it } from 'vitest';
import type { Config } from '../config/env';
import type { Database } from '../db';
import { PartyNames, shortPartyId } from './names';

describe('shortPartyId', () => {
  it('keeps the hint and shortens the namespace', () => {
    expect(shortPartyId('holder-a::1220abcdef0123456789ff')).toBe('holder-a::1220ab…ff');
  });
  it('returns ids without a namespace unchanged', () => {
    expect(shortPartyId('alice')).toBe('alice');
  });
});

const CONFIG = {
  localnet: undefined,
  parties: { treasury: 'treasury::1', agent: 'agent::1', operator: 'operator::1' },
} as unknown as Config;

/** A database whose invite query waits until `release` is called and counts its calls. */
function fakeDb(rows: { partyId: string; displayName: string }[]) {
  const state = { queries: 0, waiting: [] as (() => void)[] };
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          state.queries += 1;
          return new Promise((resolve) => {
            state.waiting.push(() => resolve(rows));
          });
        },
      }),
    }),
  } as unknown as Database;
  return { db, state, release: () => state.waiting.splice(0).forEach((fn) => fn()) };
}

describe('PartyNames refresh', () => {
  it('shares one query between concurrent calls on a stale cache', async () => {
    const { db, state, release } = fakeDb([{ partyId: 'inv::1', displayName: 'Ada' }]);
    const names = new PartyNames(CONFIG, db);
    const pending = Promise.all([names.name('inv::1'), names.name('treasury::1'), names.name('x')]);
    await Promise.resolve();
    expect(state.queries).toBe(1);
    release();
    expect(await pending).toEqual(['Ada', 'Treasury', 'x']);
    // Fresh now: no further query within the ttl.
    await names.name('inv::1');
    expect(state.queries).toBe(1);
  });

  it('starts a new query after the previous one failed', async () => {
    let calls = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: () => {
            calls += 1;
            return calls === 1
              ? Promise.reject(new Error('db down'))
              : Promise.resolve([{ partyId: 'inv::1', displayName: 'Ada' }]);
          },
        }),
      }),
    } as unknown as Database;
    const names = new PartyNames(CONFIG, db);
    await expect(names.name('inv::1')).rejects.toThrow('db down');
    expect(await names.name('inv::1')).toBe('Ada');
    expect(calls).toBe(2);
  });

  it('does not cache rows read before an invalidate', async () => {
    const { db, state, release } = fakeDb([{ partyId: 'inv::1', displayName: 'Ada' }]);
    const names = new PartyNames(CONFIG, db);
    const first = names.name('inv::1');
    await Promise.resolve();
    names.invalidate();
    release();
    await first;
    const second = names.name('inv::1');
    await Promise.resolve();
    expect(state.queries).toBe(2);
    release();
    expect(await second).toBe('Ada');
  });
});
