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

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** "Oct 14, 09:00 UTC" (year added when it is not the current year). Empty for an invalid date. */
export function formatDateTime(value: Date | string | number, now: Date = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${formatShortDate(date, now)}, ${two(date.getUTCHours())}:${two(date.getUTCMinutes())} UTC`;
}

/**
 * A short duration for countdowns: "12 s", "4 min", "5 h 12 min", "3 days". Negative or zero
 * values read as "0 s". Display only; the server decides when anything actually happens.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    const minutes = totalMinutes % 60;
    return minutes === 0 ? `${totalHours} h` : `${totalHours} h ${minutes} min`;
  }
  const days = Math.floor(totalHours / 24);
  return days === 1 ? '1 day' : `${days} days`;
}

/** "0:12" style clock for the Hold countdown. */
export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(totalSeconds / 60)}:${two(totalSeconds % 60)}`;
}

/** "age" for lists: "just now", "5 min ago", "3 h ago", "2 days ago". */
export function formatAge(value: Date | string | number, now: number = Date.now()): string {
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '';
  const diff = now - then;
  if (diff < 45_000) return 'just now';
  return `${formatDuration(diff)} ago`;
}

/** The previous calendar month as "YYYY-MM" in UTC, the default period for "Run cycle now". */
export function previousMonth(now: Date = new Date()): string {
  const year = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const month = now.getUTCMonth() === 0 ? 12 : now.getUTCMonth();
  return `${year}-${two(month)}`;
}

/** Today's date as "YYYY-MM-DD" in UTC. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** An absolute URL for an in-app path, e.g. an invite link the treasurer copies. */
export function absoluteUrl(path: string): string {
  if (typeof window === 'undefined') return path;
  return new URL(path, window.location.origin).toString();
}
