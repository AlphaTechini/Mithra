import { describe, expect, it } from 'vitest';
import {
  LfDate,
  LfDecimal,
  LfInt,
  LfTime,
  encodeDate,
  encodeDecimal,
  encodeInt,
  encodeOptional,
  encodeTextMap,
  encodeTime,
  encodeTuple2,
  encodeVariant,
  lfOptional,
  lfTextMap,
  lfTuple2,
} from './codec';
import { z } from 'zod';

describe('decimals', () => {
  it('keeps decimal strings as strings, with all their digits', () => {
    expect(LfDecimal.parse('5000.0000000000')).toBe('5000.0000000000');
    expect(LfDecimal.parse('0.0000000001')).toBe('0.0000000001');
    expect(encodeDecimal('999999999999.9999999999')).toBe('999999999999.9999999999');
  });

  it('rejects numbers, exponents and too many fraction digits', () => {
    expect(() => LfDecimal.parse(5000)).toThrow();
    expect(() => LfDecimal.parse('1e5')).toThrow();
    expect(() => encodeDecimal('0.12345678901')).toThrow();
  });
});

describe('integers', () => {
  it('parses integer strings and numbers into numbers', () => {
    expect(LfInt.parse('42')).toBe(42);
    expect(LfInt.parse('-7')).toBe(-7);
    expect(LfInt.parse(3)).toBe(3);
  });

  it('refuses unsafe integers', () => {
    expect(() => LfInt.parse('9007199254740993')).toThrow(/safe integer/);
    expect(() => LfInt.parse(1.5)).toThrow();
    expect(() => LfInt.parse('1.5')).toThrow();
    expect(() => encodeInt(2 ** 53)).toThrow(RangeError);
  });

  it('encodes integers as strings', () => {
    expect(encodeInt(600)).toBe('600');
  });
});

describe('dates and times', () => {
  it('validates the Daml date and time formats', () => {
    expect(LfDate.parse('2026-09-30')).toBe('2026-09-30');
    expect(() => LfDate.parse('30/09/2026')).toThrow();
    expect(LfTime.parse('2026-10-01T18:17:24.254844Z')).toBe('2026-10-01T18:17:24.254844Z');
    expect(() => LfTime.parse('yesterday')).toThrow();
  });

  it('encodes JS dates and ISO strings', () => {
    expect(encodeTime(new Date('2026-10-01T09:00:00Z'))).toBe('2026-10-01T09:00:00.000Z');
    expect(encodeTime('2026-10-01T09:00:00Z')).toBe('2026-10-01T09:00:00.000Z');
    expect(encodeDate('2026-09-30')).toBe('2026-09-30');
    expect(encodeDate(new Date('2026-09-30T23:59:59Z'))).toBe('2026-09-30');
    expect(() => encodeTime('nope')).toThrow(RangeError);
  });
});

describe('optional, variant, tuple and TextMap', () => {
  it('reads None as null, whether the ledger sends null or leaves the field out', () => {
    const schema = z.object({ cid: lfOptional(z.string()) });
    expect(schema.parse({ cid: null })).toEqual({ cid: null });
    expect(schema.parse({})).toEqual({ cid: null });
    expect(schema.parse({ cid: 'abc' })).toEqual({ cid: 'abc' });
  });

  it('encodes None as null and Some as the value', () => {
    expect(encodeOptional(null)).toBeNull();
    expect(encodeOptional(undefined)).toBeNull();
    expect(encodeOptional('0005', (v) => v.toUpperCase())).toBe('0005');
    expect(encodeOptional('a', (v) => v.toUpperCase())).toBe('A');
  });

  it('encodes variants as { tag, value }', () => {
    expect(encodeVariant('RefDecision', '00ab')).toEqual({ tag: 'RefDecision', value: '00ab' });
  });

  it('reads and writes tuples as { _1, _2 }', () => {
    expect(lfTuple2(z.string(), z.string()).parse({ _1: 'a', _2: 'b' })).toEqual({
      _1: 'a',
      _2: 'b',
    });
    expect(encodeTuple2('a', 'b')).toEqual({ _1: 'a', _2: 'b' });
  });

  it('reads and writes TextMaps as plain objects', () => {
    expect(lfTextMap(z.string()).parse({ k: 'v' })).toEqual({ k: 'v' });
    expect(encodeTextMap({ k: 'v' })).toEqual({ k: 'v' });
    expect(encodeTextMap([['k', 'v']] as const)).toEqual({ k: 'v' });
  });
});
