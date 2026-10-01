/** Display formatting. Amounts are decimal strings and are never converted to a JS number. */

const AMOUNT_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;
const EXACT_SCALE = 10;
const MIN_DECIMALS = 2;

export interface FormatAmountOptions {
  /** Show all 10 fraction digits instead of trimming trailing zeros. */
  exact?: boolean;
}

/**
 * Formats a decimal string with thousands separators. Trailing zeros are trimmed but at least two
 * decimals stay; with `exact` all ten decimals show. Digits are never rounded or dropped.
 * Input that is not a plain decimal string is returned unchanged.
 */
export function formatAmount(value: string, options: FormatAmountOptions = {}): string {
  const match = AMOUNT_PATTERN.exec(value.trim());
  if (!match) return value;
  const [, sign = '', rawInt = '0', rawFraction = ''] = match;

  const integer = rawInt.replace(/^0+(?=\d)/, '');
  let fraction = rawFraction;
  if (options.exact) {
    fraction = fraction.padEnd(EXACT_SCALE, '0');
  } else {
    fraction = fraction.replace(/0+$/, '').padEnd(MIN_DECIMALS, '0');
  }

  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const isZero = /^0*$/.test(integer) && /^0*$/.test(fraction);
  const prefix = sign === '-' && !isZero ? '-' : '';
  return `${prefix}${grouped}.${fraction}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 14", or "Oct 14, 2027" when the date is not in the current year. */
export function formatShortDate(value: Date | string | number, now: Date = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const month = MONTHS[date.getUTCMonth()] ?? '';
  const base = `${month} ${date.getUTCDate()}`;
  return date.getUTCFullYear() === now.getUTCFullYear()
    ? base
    : `${base}, ${date.getUTCFullYear()}`;
}

/** `hint::1220abcdef…` becomes `hint::1220ab…ef`. Ids without a hint keep only the fingerprint. */
export function shortenPartyId(id: string): string {
  const index = id.indexOf('::');
  const hint = index >= 0 ? id.slice(0, index) : '';
  const fingerprint = index >= 0 ? id.slice(index + 2) : id;
  const shortFingerprint =
    fingerprint.length > 10 ? `${fingerprint.slice(0, 6)}…${fingerprint.slice(-2)}` : fingerprint;
  const shortHint = hint.length > 24 ? `${hint.slice(0, 23)}…` : hint;
  return hint ? `${shortHint}::${shortFingerprint}` : shortFingerprint;
}
