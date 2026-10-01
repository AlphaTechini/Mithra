import { describe, expect, it } from 'vitest';
import { LedgerError } from '../ledger';
import { RegistryError } from '../wallet';
import {
  AwaitingSignatureError,
  MAINNET_SIGNING_MESSAGE,
  TreasurerPayoutExecutor,
} from './executor';
import { isTransient } from './engine';
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

describe('MainNet payout signing (M10)', () => {
  it('reports awaiting-signature with the clear message', async () => {
    const error = await new TreasurerPayoutExecutor().execute().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AwaitingSignatureError);
    expect(error).toMatchObject({
      status: 409,
      code: 'awaiting_signature',
      message: 'Signing in Grofty arrives with the MainNet build',
    });
    expect(MAINNET_SIGNING_MESSAGE).toBe('Signing in Grofty arrives with the MainNet build');
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
