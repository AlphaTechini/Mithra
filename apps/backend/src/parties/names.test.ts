import { describe, expect, it } from 'vitest';
import { shortPartyId } from './names';

describe('shortPartyId', () => {
  it('keeps the hint and shortens the namespace', () => {
    expect(shortPartyId('holder-a::1220abcdef0123456789ff')).toBe('holder-a::1220ab…ff');
  });
  it('returns ids without a namespace unchanged', () => {
    expect(shortPartyId('alice')).toBe('alice');
  });
});
