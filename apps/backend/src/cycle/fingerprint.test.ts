import { describe, expect, it } from 'vitest';
import { canonicalJson, fingerprint, sha256Hex } from './fingerprint';

describe('fingerprints', () => {
  it('canonical JSON sorts keys and has no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('is stable across key order', () => {
    const one = { holder: 'A', units: 1, nested: { x: 1, y: [1, 2] } };
    const two = { nested: { y: [1, 2], x: 1 }, units: 1, holder: 'A' };
    expect(fingerprint(one)).toBe(fingerprint(two));
  });

  it('changes when a value changes', () => {
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
    expect(fingerprint([1, 2])).not.toBe(fingerprint([2, 1]));
  });

  it('is the SHA-256 hex of the canonical JSON', () => {
    expect(fingerprint({ a: 1 })).toBe(sha256Hex('{"a":1}'));
    // Known SHA-256 of the empty string and of "abc".
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('skips undefined values like JSON does', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});
