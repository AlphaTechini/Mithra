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

/** `2026-09` -> `September 2026`. Returns the input when it is not a cycle id. */
export function cycleLabelOf(cycleId: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(cycleId);
  if (!match) return cycleId;
  const month = Number(match[2]);
  const names = [
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
  const name = names[month - 1];
  return name ? `${name} ${match[1]}` : cycleId;
}
