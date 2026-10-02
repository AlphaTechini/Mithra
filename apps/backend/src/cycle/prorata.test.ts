import { readFileSync } from 'node:fs';
import { toDecimal } from '@mithra/shared';
import { describe, expect, it } from 'vitest';
import { ProRataError, computeProRata, unitsAt } from './prorata';

interface Vector {
  name: string;
  total: string;
  holdings: { holder: string; units: number }[];
  expected?: { holder: string; amount: string }[];
  expectError?: boolean;
  recordDate?: string;
  changes?: { holder: string; delta: number; effectiveDate: string }[];
}

const vectors = JSON.parse(
  readFileSync(new URL('../../../../daml/test-vectors/prorata.json', import.meta.url), 'utf8'),
) as Vector[];

/** Fake party ids that sort like the labels do (the Daml test sorts by `partyToText`, `A::...` < `B::...`). */
const party = (label: string): string => `${label}::1220ffee00`;
const labelOf = (partyId: string): string => partyId.split('::')[0] ?? partyId;

const mapHoldings = (h: { holder: string; units: number }[]) =>
  h.map((x) => ({ holder: party(x.holder), units: x.units }));

describe('computeProRata against daml/test-vectors/prorata.json', () => {
  it('has every vector of the Daml test', () => {
    expect(vectors).toHaveLength(12);
  });

  for (const vector of vectors) {
    it(vector.name, () => {
      const holdings = mapHoldings(vector.holdings);
      if (vector.recordDate !== undefined && vector.changes) {
        const derived = unitsAt(
          vector.recordDate,
          vector.changes.map((c) => ({ ...c, holder: party(c.holder) })),
        );
        expect(derived).toEqual(holdings);
      }
      if (vector.expectError) {
        expect(() => computeProRata(vector.total, holdings)).toThrow(ProRataError);
        return;
      }
      const payouts = computeProRata(vector.total, holdings);
      expect(payouts.map((p) => labelOf(p.holder))).toEqual(
        (vector.expected ?? []).map((e) => e.holder),
      );
      for (const [index, expected] of (vector.expected ?? []).entries()) {
        const actual = payouts[index];
        expect(
          toDecimal(actual?.amount ?? '0').equals(toDecimal(expected.amount)),
          `${vector.name}: ${labelOf(actual?.holder ?? '')} ${actual?.amount} should equal ${expected.amount}`,
        ).toBe(true);
      }
      // The amounts add up to the total exactly, and units are carried on the payouts.
      const sum = payouts.reduce((acc, p) => acc.plus(toDecimal(p.amount)), toDecimal('0'));
      expect(sum.equals(toDecimal(vector.total))).toBe(true);
      expect(payouts.map((p) => p.units)).toEqual(holdings.map((h) => h.units));
      // Amounts are strings with 10 fraction digits, as the ledger sends them.
      for (const p of payouts) expect(p.amount).toMatch(/^\d+\.\d{10}$/);
    });
  }
});

describe('computeProRata rejections', () => {
  it('rejects a total that is not positive', () => {
    expect(() => computeProRata('0', [{ holder: party('A'), units: 1 }])).toThrow(
      'Total must be greater than zero',
    );
  });

  it('rejects no holders', () => {
    expect(() => computeProRata('100', [])).toThrow('No fund unit holders on the record date');
  });

  it('rejects a holder with no units', () => {
    expect(() => computeProRata('100', [{ holder: party('A'), units: 0 }])).toThrow(
      'Every holder must hold a positive number of units',
    );
  });

  it('says what to do when the total is too small for every holder', () => {
    expect(() =>
      computeProRata('0.0000000002', [
        { holder: party('A'), units: 1 },
        { holder: party('B'), units: 1000 },
      ]),
    ).toThrow('Distribute a larger amount');
  });

  it('does not depend on the order holdings are given in', () => {
    const a = computeProRata(
      '100',
      mapHoldings([
        { holder: 'B', units: 2 },
        { holder: 'A', units: 1 },
      ]),
    );
    const b = computeProRata(
      '100',
      mapHoldings([
        { holder: 'A', units: 1 },
        { holder: 'B', units: 2 },
      ]),
    );
    expect(a).toEqual(b);
  });
});

describe('unitsAt', () => {
  it('sums changes effective on or before the record date and drops non-positive holders', () => {
    const changes = [
      { holder: party('B'), delta: 100, effectiveDate: '2026-01-01' },
      { holder: party('A'), delta: 50, effectiveDate: '2026-09-30' },
      { holder: party('A'), delta: 25, effectiveDate: '2026-10-01' },
      { holder: party('C'), delta: 10, effectiveDate: '2026-01-01' },
      { holder: party('C'), delta: -10, effectiveDate: '2026-02-01' },
    ];
    expect(unitsAt('2026-09-30', changes)).toEqual([
      { holder: party('A'), units: 50 },
      { holder: party('B'), units: 100 },
    ]);
  });
});
