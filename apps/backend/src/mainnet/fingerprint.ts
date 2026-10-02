import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';

/**
 * Canton party fingerprints and Ed25519 checks for the Grofty wallet registration.
 *
 * A Canton party id is `hint::namespace`. For a party that owns its namespace key, the namespace
 * is the key's fingerprint: the hex of the multihash prefix `0x12 0x20` followed by
 * `SHA-256(uint32_be(12) || publicKeyBytes)` (12 is the hash purpose "public key fingerprint").
 * Proving control of the party means (1) the namespace of the party id equals the fingerprint of
 * the public key and (2) the key signed our challenge.
 */

const FINGERPRINT_PURPOSE = 12;

/** The 12-byte prefix of a DER X.509 SubjectPublicKeyInfo for a raw Ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

/** The fingerprint of public key bytes, as Canton writes it in a party id (lowercase hex). */
export function fingerprintOfPublicKey(publicKey: Uint8Array): string {
  const purpose = Buffer.alloc(4);
  purpose.writeUInt32BE(FINGERPRINT_PURPOSE, 0);
  const digest = createHash('sha256').update(purpose).update(publicKey).digest();
  return Buffer.concat([Buffer.from([0x12, 0x20]), digest]).toString('hex');
}

/** The party namespace: what follows the last `::` of the party id, or null when there is none. */
export function namespaceOfParty(partyId: string): string | null {
  const index = partyId.lastIndexOf('::');
  if (index <= 0 || index === partyId.length - 2) return null;
  return partyId.slice(index + 2);
}

const HEX = /^[0-9a-fA-F]+$/;
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * Bytes from a base64 (standard or URL-safe, padded or not) or hex string, or null.
 * A string that is valid hex of exactly `lengths` bytes is read as hex, otherwise as base64: the
 * two alphabets overlap, so the expected length decides.
 */
export function decodeBytes(input: string, lengths: readonly number[]): Buffer | null {
  const text = input.trim();
  if (text === '') return null;
  if (HEX.test(text) && text.length % 2 === 0) {
    const bytes = Buffer.from(text, 'hex');
    if (lengths.includes(bytes.length)) return bytes;
  }
  if (BASE64.test(text)) {
    const standard = text.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Buffer.from(standard, 'base64');
    if (lengths.includes(bytes.length)) return bytes;
  }
  return null;
}

/** The public key as given (raw 32 bytes, or a 44-byte DER SubjectPublicKeyInfo) and its raw bytes. */
export function parsePublicKey(input: string): { given: Buffer; raw: Buffer } | null {
  const given = decodeBytes(input, [
    ED25519_KEY_BYTES,
    ED25519_SPKI_PREFIX.length + ED25519_KEY_BYTES,
  ]);
  if (!given) return null;
  if (given.length === ED25519_KEY_BYTES) return { given, raw: given };
  if (!given.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) return null;
  return { given, raw: given.subarray(ED25519_SPKI_PREFIX.length) };
}

/**
 * True when the namespace of `partyId` is the fingerprint of the public key. A raw key is also
 * accepted when the namespace was computed over its DER form (Canton fingerprints the serialized
 * key; which form Grofty reports is unverified, so both are accepted).
 */
export function partyMatchesKey(
  partyId: string,
  publicKey: { given: Buffer; raw: Buffer },
): boolean {
  const namespace = namespaceOfParty(partyId)?.toLowerCase();
  if (!namespace) return false;
  const candidates = [fingerprintOfPublicKey(publicKey.given)];
  if (publicKey.given.length === ED25519_KEY_BYTES) {
    candidates.push(fingerprintOfPublicKey(Buffer.concat([ED25519_SPKI_PREFIX, publicKey.raw])));
  }
  return candidates.includes(namespace);
}

/** Ed25519 signature check over the UTF-8 bytes of `message`; signature in base64 or hex. */
export function verifyMessageSignature(
  message: string,
  signature: string,
  publicKey: { raw: Buffer },
): boolean {
  const bytes = decodeBytes(signature, [ED25519_SIGNATURE_BYTES]);
  if (!bytes) return false;
  try {
    return nacl.sign.detached.verify(
      new Uint8Array(Buffer.from(message, 'utf8')),
      new Uint8Array(bytes),
      new Uint8Array(publicKey.raw),
    );
  } catch {
    return false;
  }
}
