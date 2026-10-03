import { DecimalString, formatDecimal } from '@mithra/shared';
import Decimal from 'decimal.js';
import type { Payout, UnitChange } from '../ledger';

/**
 * The pro-rata rule of docs/ledger-model.md (L2, A3). This is the only place amounts are computed;
 * the Mandate recomputes the same split on the ledger and refuses any other.
 *
 * Division truncates (ROUND_DOWN) at a precision far above 10 places, so a quotient can never be
 * rounded up before it is floored to 10 places.
 */
const Exact = Decimal.clone({ precision: 100, rounding: Decimal.ROUND_DOWN });

/** The smallest amount a payment can have: 0.0000000001. */
const MIN_AMOUNT = new Exact('0.0000000001');

export interface Holding {
  holder: string;
  units: number;
}

/** The split cannot be made; `message` says why and what to change. */
export class ProRataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProRataError';
  }
}

function byHolder(a: Holding, b: Holding): number {
  return a.holder < b.holder ? -1 : a.holder > b.holder ? 1 : 0;
}

/**
 * Splits `total` over `holdings` pro rata:
 * 1. holders sorted by party id ascending;
 * 2. each share is `total * units / totalUnits` rounded DOWN to 10 places;
 * 3. the residual (total minus the shares) goes to the holder with the most units, the first in
 *    sort order on ties, so the amounts add up to `total` exactly;
 * 4. rejected when the total is not positive, there are no holders, or any amount would be below
 *    0.0000000001 (a payment of zero cannot be made).
 *
 * Amounts are decimal strings with 10 fraction digits, as the ledger sends them.
 */
export function computeProRata(total: string, holdings: readonly Holding[]): Payout[] {
  const totalDec = new Exact(DecimalString.parse(total));
  if (!totalDec.gt(0)) throw new ProRataError('Total must be greater than zero');
  if (holdings.length === 0) throw new ProRataError('No fund unit holders on the record date');
  if (holdings.some((h) => !Number.isSafeInteger(h.units) || h.units <= 0)) {
    throw new ProRataError('Every holder must hold a positive number of units');
  }
  const sorted = [...holdings].sort(byHolder);
  const totalUnits = sorted.reduce((sum, h) => sum.plus(h.units), new Exact(0));
  const shares = sorted.map((h) =>
    totalDec.times(h.units).div(totalUnits).toDecimalPlaces(10, Decimal.ROUND_DOWN),
  );
  const residual = totalDec.minus(shares.reduce((sum, s) => sum.plus(s), new Exact(0)));
  const maxUnits = Math.max(...sorted.map((h) => h.units));
  const firstMax = sorted.findIndex((h) => h.units === maxUnits);
  const payouts = sorted.map((h, index) => {
    const share = shares[index] ?? new Exact(0);
    const amount = index === firstMax ? share.plus(residual) : share;
    return { holder: h.holder, units: h.units, amount };
  });
  if (payouts.some((p) => p.amount.lt(MIN_AMOUNT))) {
    throw new ProRataError(
      'Total is too small to give every holder at least 0.0000000001. Distribute a larger amount.',
    );
  }
  return payouts.map((p) => ({
    holder: p.holder,
    units: p.units,
    amount: formatDecimal(p.amount),
  }));
}

/** The part of a unit change the snapshot needs. */
export type UnitChangeLike = Pick<UnitChange, 'holder' | 'delta' | 'effectiveDate'>;

/**
 * Units held on `recordDate` ("YYYY-MM-DD"): for each holder the sum of `delta` over changes
 * effective on or before that date. Only holders with a positive sum, sorted by party id.
 */
export function unitsAt(recordDate: string, changes: readonly UnitChangeLike[]): Holding[] {
  const sums = new Map<string, number>();
  for (const change of changes) {
    if (change.effectiveDate <= recordDate) {
      sums.set(change.holder, (sums.get(change.holder) ?? 0) + change.delta);
    }
  }
  return [...sums.entries()]
    .filter(([, units]) => units > 0)
    .map(([holder, units]) => ({ holder, units }))
    .sort(byHolder);
}
