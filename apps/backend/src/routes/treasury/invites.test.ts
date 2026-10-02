import { describe, expect, it } from 'vitest';
import {
  INVITE_ALPHABET,
  INVITE_CODE_LENGTH,
  isInviteCode,
  newInviteCode,
  normalizeInviteCode,
} from './invites';

describe('invite codes', () => {
  it('has 8 characters from A-Z and 2-9 without ambiguous ones', () => {
    for (let i = 0; i < 500; i += 1) {
      const code = newInviteCode();
      expect(code).toHaveLength(INVITE_CODE_LENGTH);
      expect(code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
      expect(code).not.toMatch(/[ILO01]/);
      expect(isInviteCode(code)).toBe(true);
    }
  });

  it('uses every character of the alphabet and never a look-alike', () => {
    expect(INVITE_ALPHABET).toHaveLength(31);
    for (const ch of 'ILO01') expect(INVITE_ALPHABET).not.toContain(ch);
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) for (const ch of newInviteCode()) seen.add(ch);
    expect(seen.size).toBe(INVITE_ALPHABET.length);
  });

  it('draws each character through the random source', () => {
    let calls = 0;
    const code = newInviteCode((max) => {
      calls += 1;
      expect(max).toBe(INVITE_ALPHABET.length);
      return calls - 1;
    });
    expect(calls).toBe(8);
    expect(code).toBe(INVITE_ALPHABET.slice(0, 8));
  });

  it('normalizes what people paste and rejects other shapes', () => {
    expect(normalizeInviteCode('  ab3k7mnp ')).toBe('AB3K7MNP');
    expect(isInviteCode('AB3K7MNP')).toBe(true);
    expect(isInviteCode('AB3K7MN')).toBe(false);
    expect(isInviteCode('AB3K7MN0')).toBe(false);
    expect(isInviteCode("AB3K7MN'--")).toBe(false);
  });
});
