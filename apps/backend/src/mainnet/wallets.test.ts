import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import type { Database } from '../db';
import { ApiError } from '../http/errors';
import { fingerprintOfPublicKey } from './fingerprint';
import { CHALLENGE_TTL_MS, INVALID_SIGNATURE_MESSAGE, MainnetWallets } from './wallets';

/** A database that stores nothing and holds nobody's wallet (the checks run before it matters). */
function fakeDb(rows: { holderParty: string; mainnetParty: string }[] = []) {
  const stored: unknown[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(rows) }),
        then: undefined,
      }),
    }),
    insert: () => ({
      values: (value: unknown) => ({
        onConflictDoUpdate: () => {
          stored.push(value);
          return Promise.resolve();
        },
      }),
    }),
  };
  return { db: db as unknown as Database, stored };
}

function wallet() {
  const pair = nacl.sign.keyPair();
  const partyId = `holder::${fingerprintOfPublicKey(pair.publicKey)}`;
  const sign = (message: string): string =>
    Buffer.from(
      nacl.sign.detached(new Uint8Array(Buffer.from(message, 'utf8')), pair.secretKey),
    ).toString('base64');
  return { pair, partyId, publicKey: Buffer.from(pair.publicKey).toString('base64'), sign };
}

const errorOf = async (promise: Promise<unknown>): Promise<ApiError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected an ApiError');
};

describe('connection challenge', () => {
  it('has the documented message and a random nonce each time', () => {
    const wallets = new MainnetWallets(fakeDb().db, {
      now: () => Date.parse('2026-10-01T09:00:00Z'),
    });
    const a = wallets.challenge('holder-a', 'Holder A');
    const b = wallets.challenge('holder-a', 'Holder A');
    expect(a.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.message).toBe(
      `Connect your Grofty Wallet to Mithra\nHolder: Holder A\nNonce: ${a.nonce}\nIssued: 2026-10-01T09:00:00.000Z`,
    );
  });

  it('registers a wallet that signed it, and stores the pairing', async () => {
    const { db, stored } = fakeDb();
    const wallets = new MainnetWallets(db);
    const w = wallet();
    const { nonce, message } = wallets.challenge('holder-a', 'Holder A');
    const result = await wallets.register('holder-a', {
      partyId: w.partyId,
      publicKey: w.publicKey,
      signature: w.sign(message),
      nonce,
    });
    expect(result).toEqual({ partyId: w.partyId });
    expect(stored).toMatchObject([
      { holderParty: 'holder-a', mainnetParty: w.partyId, publicKey: w.publicKey },
    ]);
  });

  it('is single use, even after a bad signature', async () => {
    const { db } = fakeDb();
    const wallets = new MainnetWallets(db);
    const w = wallet();
    const { nonce, message } = wallets.challenge('holder-a', 'Holder A');
    const bad = await errorOf(
      wallets.register('holder-a', {
        partyId: w.partyId,
        publicKey: w.publicKey,
        signature: wallet().sign(message),
        nonce,
      }),
    );
    expect(bad).toMatchObject({
      status: 401,
      code: 'invalid_signature',
      message: INVALID_SIGNATURE_MESSAGE,
    });
    const reuse = await errorOf(
      wallets.register('holder-a', {
        partyId: w.partyId,
        publicKey: w.publicKey,
        signature: w.sign(message),
        nonce,
      }),
    );
    expect(reuse).toMatchObject({ status: 400, code: 'invalid_nonce' });
  });

  it('is single use after a success', async () => {
    const { db } = fakeDb();
    const wallets = new MainnetWallets(db);
    const w = wallet();
    const { nonce, message } = wallets.challenge('holder-a', 'Holder A');
    const body = { partyId: w.partyId, publicKey: w.publicKey, signature: w.sign(message), nonce };
    await wallets.register('holder-a', body);
    expect(await errorOf(wallets.register('holder-a', body))).toMatchObject({
      code: 'invalid_nonce',
    });
  });

  it('expires after 5 minutes', async () => {
    let now = Date.parse('2026-10-01T09:00:00Z');
    const wallets = new MainnetWallets(fakeDb().db, { now: () => now });
    const w = wallet();
    const { nonce, message } = wallets.challenge('holder-a', 'Holder A');
    expect(CHALLENGE_TTL_MS).toBe(5 * 60 * 1000);
    now += CHALLENGE_TTL_MS;
    const error = await errorOf(
      wallets.register('holder-a', {
        partyId: w.partyId,
        publicKey: w.publicKey,
        signature: w.sign(message),
        nonce,
      }),
    );
    expect(error).toMatchObject({ status: 400, code: 'invalid_nonce' });
  });

  it('is bound to the holder it was issued to, and unknown nonces are refused', async () => {
    const wallets = new MainnetWallets(fakeDb().db);
    const w = wallet();
    const { nonce, message } = wallets.challenge('holder-a', 'Holder A');
    const body = { partyId: w.partyId, publicKey: w.publicKey, signature: w.sign(message), nonce };
    expect(await errorOf(wallets.register('holder-b', body))).toMatchObject({
      code: 'invalid_nonce',
    });
    expect(await errorOf(wallets.register('holder-a', { ...body, nonce: 'nope' }))).toMatchObject({
      code: 'invalid_nonce',
    });
  });

  it('refuses a party id that does not belong to the key, a bad key and a stolen signature', async () => {
    const wallets = new MainnetWallets(fakeDb().db);
    const w = wallet();
    const other = wallet();
    const attempt = async (patch: Record<string, string>) => {
      const { nonce, message } = wallets.challenge('holder-a', 'Holder A');
      return errorOf(
        wallets.register('holder-a', {
          partyId: w.partyId,
          publicKey: w.publicKey,
          signature: w.sign(message),
          nonce,
          ...patch,
        }),
      );
    };
    expect(await attempt({ partyId: other.partyId })).toMatchObject({ code: 'invalid_signature' });
    expect(await attempt({ publicKey: other.publicKey })).toMatchObject({
      code: 'invalid_signature',
    });
    expect(await attempt({ publicKey: 'garbage' })).toMatchObject({ code: 'invalid_signature' });
    expect(await attempt({ signature: other.sign('another message') })).toMatchObject({
      code: 'invalid_signature',
    });
  });

  it('refuses a wallet that is already connected to another holder', async () => {
    const w = wallet();
    const { db } = fakeDb([{ holderParty: 'holder-z', mainnetParty: w.partyId }]);
    const wallets = new MainnetWallets(db);
    const { nonce, message } = wallets.challenge('holder-a', 'Holder A');
    const error = await errorOf(
      wallets.register('holder-a', {
        partyId: w.partyId,
        publicKey: w.publicKey,
        signature: w.sign(message),
        nonce,
      }),
    );
    expect(error).toMatchObject({ status: 409, code: 'wallet_in_use' });
  });
});
