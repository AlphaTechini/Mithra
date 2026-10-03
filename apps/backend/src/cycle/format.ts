import Decimal from 'decimal.js';
import { toDecimal } from '@mithra/shared';

/** Decimal arithmetic for display and checks; amounts are never JS numbers. */
export const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP });

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Parses a whole number written in decimal digits (dates, counts); never an amount. */
export function int(text: string): number {
  return Number.parseInt(text, 10);
}

/** `1234567` -> `1,234,567`. Input is a string of digits (optionally with a leading minus). */
export function groupThousands(digits: string): string {
  const negative = digits.startsWith('-');
  const body = negative ? digits.slice(1) : digits;
  const grouped = body.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return negative ? `-${grouped}` : grouped;
}

/**
 * An amount for people: thousands separators, no trailing zeros, no symbol.
 * `1200.5000000000` -> `1,200.5`. Same rule as Daml's `showAmount`.
 */
export function showAmountText(value: string | Decimal): string {
  const dec = typeof value === 'string' ? toDecimal(value) : new D(value);
  const text = dec.toFixed();
  const [whole = '0', fraction = ''] = text.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed === '' ? groupThousands(whole) : `${groupThousands(whole)}.${trimmed}`;
}

/** `formatAmount('1200.0', 'CC')` -> `1,200 CC`. */
export function formatAmount(value: string | Decimal, symbol: string): string {
  return `${showAmountText(value)} ${symbol}`;
}

/** An amount rounded half up to `places` fraction digits (display only), then formatted as above. */
export function formatRounded(value: Decimal, places: number): string {
  return showAmountText(new D(value).toDecimalPlaces(places, Decimal.ROUND_HALF_UP));
}

/** `+193%`, `-40%`, `+0.4%`: rounded to whole percent, one decimal below 1%. Display only. */
export function formatSignedPct(pct: Decimal): string {
  const abs = pct.abs();
  const shown = abs.lt(1) ? abs.toDecimalPlaces(1) : abs.toDecimalPlaces(0);
  const sign = pct.isNegative() && !shown.isZero() ? '-' : '+';
  return `${sign}${shown.toFixed()}%`;
}

/** `2026-09` -> `September 2026`. */
export function cycleLabel(cycleId: string): string {
  const [year = '', month = ''] = cycleId.split('-');
  const name = MONTHS[int(month) - 1];
  return name ? `${name} ${year}` : cycleId;
}

/** `2026-09` -> `September`. */
export function monthName(cycleId: string): string {
  const month = int(cycleId.split('-')[1] ?? '');
  return MONTHS[month - 1] ?? cycleId;
}

/** `2026-09-30` -> `Sep 30`. */
export function shortDate(isoDate: string): string {
  const [, month = '', day = ''] = isoDate.split('-');
  const name = MONTHS[int(month) - 1];
  return name ? `${name.slice(0, 3)} ${int(day)}` : isoDate;
}

/** `1 holder` / `4 holders`. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
