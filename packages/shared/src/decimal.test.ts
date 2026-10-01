import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { DecimalString, formatDecimal, sumDecimals, toDecimal } from './index';

describe('DecimalString', () => {
  it.each(['0', '1', '-1', '12345', '0.1', '-0.5', '100.0000000001', '0.0000000001', '007'])(
    'accepts %s',
    (s) => {
      expect(DecimalString.safeParse(s).success).toBe(true);
    },
  );

  it.each([
    '',
    ' 1',
    '1 ',
    '+1',
    '1e5',
    '1E-3',
    '.5',
    '5.',
    '1.00000000001',
    '--1',
    '1,000',
    '0x10',
    'abc',
    'NaN',
    'Infinity',
  ])('rejects %j', (s) => {
    expect(DecimalString.safeParse(s).success).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(DecimalString.safeParse(1).success).toBe(false);
    expect(DecimalString.safeParse(null).success).toBe(false);
  });
});

describe('toDecimal and formatDecimal', () => {
  it('formats with exactly 10 places', () => {
    expect(formatDecimal(toDecimal('1'))).toBe('1.0000000000');
    expect(formatDecimal(toDecimal('-0.5'))).toBe('-0.5000000000');
    expect(formatDecimal(toDecimal('100.0000000001'))).toBe('100.0000000001');
  });

  it('round trips', () => {
    for (const s of ['0.0000000000', '1.2345678901', '-42.0000000000', '999999999.9999999999']) {
      expect(formatDecimal(toDecimal(s))).toBe(s);
    }
  });

  it('throws on invalid input', () => {
    expect(() => toDecimal('1e5')).toThrow();
    expect(() => toDecimal('')).toThrow();
  });

  it('is unaffected by global Decimal configuration', () => {
    const previous = Decimal.precision;
    Decimal.set({ precision: 3 });
    try {
      expect(formatDecimal(toDecimal('123456.1234567890'))).toBe('123456.1234567890');
    } finally {
      Decimal.set({ precision: previous });
    }
  });
});

describe('sumDecimals', () => {
  it('has no float error: 0.1 + 0.2 equals 0.3 exactly', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(sumDecimals(['0.1', '0.2'])).toBe('0.3000000000');
    expect(sumDecimals(['0.1', '0.2'])).toBe(formatDecimal(toDecimal('0.3')));
  });

  it('sums many small amounts exactly', () => {
    const tenths = Array.from({ length: 10 }, () => '0.1');
    expect(sumDecimals(tenths)).toBe('1.0000000000');
  });

  it('handles negatives and the empty sum', () => {
    expect(sumDecimals(['5', '-7.5'])).toBe('-2.5000000000');
    expect(sumDecimals([])).toBe('0.0000000000');
  });

  it('rejects an invalid element', () => {
    expect(() => sumDecimals(['1', '1e2'])).toThrow();
  });
});
