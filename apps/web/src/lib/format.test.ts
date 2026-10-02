import { describe, expect, it } from 'vitest';
import { formatAmount, formatShortDate, shortenPartyId } from './format';

describe('formatAmount', () => {
  it('trims trailing zeros but keeps two decimals', () => {
    expect(formatAmount('0.1000000000')).toBe('0.10');
    expect(formatAmount('1200.0000000000')).toBe('1,200.00');
    expect(formatAmount('5')).toBe('5.00');
    expect(formatAmount('7.5')).toBe('7.50');
  });

  it('keeps every significant digit without rounding or converting to a float', () => {
    expect(formatAmount('123456789.1234567891')).toBe('123,456,789.1234567891');
    expect(formatAmount('9007199254740993.0000000001')).toBe('9,007,199,254,740,993.0000000001');
  });

  it('formats negatives', () => {
    expect(formatAmount('-1200.5000000000')).toBe('-1,200.50');
    expect(formatAmount('-0.0000000000')).toBe('0.00');
  });

  it('shows all ten decimals when exact', () => {
    expect(formatAmount('1200.5', { exact: true })).toBe('1,200.5000000000');
    expect(formatAmount('0.1000000000', { exact: true })).toBe('0.1000000000');
    expect(formatAmount('42', { exact: true })).toBe('42.0000000000');
  });

  it('groups thousands and strips leading zeros', () => {
    expect(formatAmount('1000000')).toBe('1,000,000.00');
    expect(formatAmount('999')).toBe('999.00');
    expect(formatAmount('007.25')).toBe('7.25');
  });

  it('returns input that is not a plain decimal unchanged', () => {
    expect(formatAmount('1e5')).toBe('1e5');
    expect(formatAmount('abc')).toBe('abc');
  });
});

describe('formatShortDate', () => {
  const now = new Date('2026-10-01T00:00:00Z');
  it('omits the year in the current year', () => {
    expect(formatShortDate('2026-10-14T12:00:00Z', now)).toBe('Oct 14');
  });
  it('adds the year otherwise', () => {
    expect(formatShortDate('2027-01-02T12:00:00Z', now)).toBe('Jan 2, 2027');
  });
  it('returns an empty string for an invalid date', () => {
    expect(formatShortDate('nope', now)).toBe('');
  });
});

describe('shortenPartyId', () => {
  it('keeps the hint and shortens the fingerprint', () => {
    expect(shortenPartyId('treasurer::1220abcdef1234567890cd')).toBe('treasurer::1220ab…cd');
  });
  it('leaves short ids alone', () => {
    expect(shortenPartyId('a::1220')).toBe('a::1220');
  });
});
