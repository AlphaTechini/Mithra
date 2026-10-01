import { toDecimal } from '@mithra/shared';
import type Decimal from 'decimal.js';

/** `1200.5000000000` -> `1,200.5`; `5000` -> `5,000`. For text people read; never parsed back. */
export function formatAmount(value: string | Decimal): string {
  const d = typeof value === 'string' ? toDecimal(value) : value;
  const [whole = '0', fraction] = d.toFixed().split('.');
  const negative = whole.startsWith('-');
  const digits = negative ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${fraction ? `.${fraction}` : ''}`;
}

const MONTH_NAMES = [
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
];

/** `2026-09` -> `September 2026`. Returns the input when it is not a cycle id. */
export function cycleLabelOf(cycleId: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(cycleId);
  if (!match) return cycleId;
  const name = MONTH_NAMES[Number(match[2]) - 1];
  return name ? `${name} ${match[1]}` : cycleId;
}

/** `2026-10-01T09:00:00Z` -> `1 October 2026` (UTC). Returns the input when it is not a time. */
export function longDateOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()] ?? ''} ${date.getUTCFullYear()}`;
}

/** `1 payee` / `4 payees`. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
