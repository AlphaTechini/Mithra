import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import {
  decodeBytes,
  fingerprintOfPublicKey,
  namespaceOfParty,
  parsePublicKey,
  partyMatchesKey,
  verifyMessageSignature,
} from './fingerprint';

/**
 * An independent implementation of the Canton rule, written differently on purpose: the
 * namespace is hex(0x12, 0x20) followed by SHA-256 of the 4-byte big-endian number 12 and the key.
 */
function independentNamespace(publicKey: Uint8Array): string {
  const input = new Uint8Array(4 + publicKey.length);
  new DataView(input.buffer).setUint32(0, 12, false);
  input.set(publicKey, 4);
  const digest = [...createHash('sha256').update(input).digest()];
  return [0x12, 0x20, ...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

describe('party fingerprint', () => {
  it('matches an independent implementation for many tweetnacl keys', () => {
    for (let i = 0; i < 25; i += 1) {
      const { publicKey } = nacl.sign.keyPair();
      const expected = independentNamespace(publicKey);
      expect(fingerprintOfPublicKey(publicKey)).toBe(expected);
      expect(expected).toMatch(/^1220[0-9a-f]{64}$/);
    }
  });

  it('is the namespace of the party id, and only the last "::" counts', () => {
    expect(namespaceOfParty('holder-a::1220abcd')).toBe('1220abcd');
    expect(namespaceOfParty('a::b::1220abcd')).toBe('1220abcd');
    expect(namespaceOfParty('no-namespace')).toBeNull();
    expect(namespaceOfParty('trailing::')).toBeNull();
    expect(namespaceOfParty('::1220abcd')).toBeNull();
  });

  it('accepts the party of the key and nobody else', () => {
    const mine = nacl.sign.keyPair();
    const other = nacl.sign.keyPair();
    const key = parsePublicKey(b64(mine.publicKey));
    expect(key).not.toBeNull();
    if (!key) return;
    expect(partyMatchesKey(`alice::${independentNamespace(mine.publicKey)}`, key)).toBe(true);
    // Hex case does not matter.
    expect(
      partyMatchesKey(`alice::${independentNamespace(mine.publicKey).toUpperCase()}`, key),
    ).toBe(true);
    expect(partyMatchesKey(`alice::${independentNamespace(other.publicKey)}`, key)).toBe(false);
    expect(partyMatchesKey('alice', key)).toBe(false);
    expect(partyMatchesKey('alice::1220', key)).toBe(false);
  });

  it('reads a DER key and also accepts the namespace of the DER form for a raw key', () => {
    const { publicKey } = nacl.sign.keyPair();
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]);
    const der = parsePublicKey(b64(spki));
    expect(der?.raw.equals(Buffer.from(publicKey))).toBe(true);
    if (!der) return;
    expect(partyMatchesKey(`a::${independentNamespace(spki)}`, der)).toBe(true);
    const raw = parsePublicKey(hex(publicKey));
    expect(raw).not.toBeNull();
    if (!raw) return;
    expect(partyMatchesKey(`a::${independentNamespace(spki)}`, raw)).toBe(true);
    expect(parsePublicKey(b64(Buffer.concat([Buffer.alloc(12), publicKey])))).toBeNull();
  });
});

describe('decodeBytes', () => {
  it('reads base64 (standard, URL-safe, unpadded) and hex of the expected length', () => {
    const bytes = nacl.randomBytes(64);
    const standard = b64(bytes);
    expect(decodeBytes(standard, [64])?.equals(Buffer.from(bytes))).toBe(true);
    expect(decodeBytes(standard.replace(/=+$/, ''), [64])?.equals(Buffer.from(bytes))).toBe(true);
    const urlSafe = standard.replace(/\+/g, '-').replace(/\//g, '_');
    expect(decodeBytes(urlSafe, [64])?.equals(Buffer.from(bytes))).toBe(true);
    expect(decodeBytes(hex(bytes), [64])?.equals(Buffer.from(bytes))).toBe(true);
    expect(decodeBytes(` ${hex(bytes)}\n`, [64])?.equals(Buffer.from(bytes))).toBe(true);
  });

  it('refuses the wrong length and non-encodings', () => {
    expect(decodeBytes(b64(nacl.randomBytes(31)), [32])).toBeNull();
    expect(decodeBytes('', [32])).toBeNull();
    expect(decodeBytes('not base64 !!', [32])).toBeNull();
    // 64 hex characters are 32 bytes as hex, but 48 bytes as base64: the expected length decides.
    const key = nacl.randomBytes(32);
    expect(decodeBytes(hex(key), [32])?.length).toBe(32);
    expect(decodeBytes(hex(key), [48])?.length).toBe(48);
  });
});

describe('signature check', () => {
  const message =
    'Connect your Grofty Wallet to Mithra\nHolder: Holder A\nNonce: abc\nIssued: 2026-10-01T00:00:00.000Z';
  const pair = nacl.sign.keyPair();
  const sign = (text: string): Uint8Array =>
    nacl.sign.detached(new Uint8Array(Buffer.from(text, 'utf8')), pair.secretKey);
  const key = { raw: Buffer.from(pair.publicKey) };

  it('accepts an Ed25519 signature over the UTF-8 bytes, in base64 or hex', () => {
    const signature = sign(message);
    expect(verifyMessageSignature(message, b64(signature), key)).toBe(true);
    expect(verifyMessageSignature(message, hex(signature), key)).toBe(true);
    expect(verifyMessageSignature(message, hex(signature).toUpperCase(), key)).toBe(true);
  });

  it('refuses another message, another key, a damaged or malformed signature', () => {
    const signature = sign(message);
    expect(verifyMessageSignature(`${message}!`, b64(signature), key)).toBe(false);
    const other = nacl.sign.keyPair();
    expect(
      verifyMessageSignature(message, b64(signature), { raw: Buffer.from(other.publicKey) }),
    ).toBe(false);
    const damaged = Uint8Array.from(signature);
    damaged[3] = (damaged[3] ?? 0) ^ 0xff;
    expect(verifyMessageSignature(message, b64(damaged), key)).toBe(false);
    expect(verifyMessageSignature(message, 'abc', key)).toBe(false);
    expect(verifyMessageSignature(message, '', key)).toBe(false);
  });

  it('signs the UTF-8 bytes: a non-ASCII holder name works', () => {
    const text = 'Holder: Zoë Åström 🌿';
    expect(verifyMessageSignature(text, b64(sign(text)), key)).toBe(true);
  });
});
