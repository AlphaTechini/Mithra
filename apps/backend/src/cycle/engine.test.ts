import { describe, expect, it } from 'vitest';
import { LedgerError } from '../ledger';
import { RegistryError } from '../wallet';
import type { Mandate } from '../ledger';
import { isTransient, nextAttempt } from './engine';
import { Mutex } from './mutex';

describe('which payout failures are tried again', () => {
  const ledgerError = (status: number, retryable: boolean): LedgerError =>
    new LedgerError({ code: 'X', message: 'm', retryable, status });

  it('retries when the ledger did not answer or reports a transient failure', () => {
    expect(isTransient(ledgerError(0, true))).toBe(true);
    expect(isTransient(ledgerError(503, true))).toBe(true);
  });

  it('does not retry a definite refusal', () => {
    expect(isTransient(ledgerError(400, false))).toBe(false);
  });

  it('retries a registry that is unreachable or failing, not one that refuses the request', () => {
    expect(isTransient(new RegistryError('down', 0))).toBe(true);
    expect(isTransient(new RegistryError('boom', 502))).toBe(true);
    expect(isTransient(new RegistryError('bad request', 400))).toBe(false);
  });

  it('does not retry an unknown error', () => {
    expect(isTransient(new Error('bug'))).toBe(false);
  });
});

describe('the next attempt number of a cycle', () => {
  const mandate = {
    cycleAttempts: [
      { cycleId: '2026-08', attempt: 2 },
      { cycleId: '2026-09', attempt: 1 },
    ],
  } as Mandate;

  it('is one more than the newest attempt the Mandate recorded, and 1 for a cycle it has not seen', () => {
    expect(nextAttempt(mandate, '2026-08')).toBe(3);
    expect(nextAttempt(mandate, '2026-09')).toBe(2);
    expect(nextAttempt(mandate, '2026-10')).toBe(1);
    expect(nextAttempt({ cycleAttempts: [] } as unknown as Mandate, '2026-09')).toBe(1);
  });
});

describe('Mutex', () => {
  it('runs one function at a time, in order, and survives a failure', async () => {
    const mutex = new Mutex();
    const order: string[] = [];
    const slow = mutex.run(async () => {
      order.push('a start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('a end');
    });
    const failing = mutex.run(() => Promise.reject(new Error('boom')));
    const last = mutex.run(() => {
      order.push('c');
      return Promise.resolve('done');
    });
    await slow;
    await expect(failing).rejects.toThrow('boom');
    expect(await last).toBe('done');
    expect(order).toEqual(['a start', 'a end', 'c']);
  });
});
