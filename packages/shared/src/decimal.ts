import Decimal from 'decimal.js';
import { z } from 'zod';

/** Number of fractional digits used by amounts (matches Daml Numeric 10). */
const SCALE = 10;

/**
 * A decimal amount as a string: optional minus, digits, optional fraction of up to 10 places.
 * No exponent, no leading plus, no surrounding whitespace. Amounts always travel as strings.
 */
export const DecimalString = z
  .string()
  .regex(/^-?\d+(\.\d{1,10})?$/, 'Expected a decimal string with up to 10 fraction digits');

// Dedicated constructor so global Decimal settings can never leak into amount arithmetic.
const MithraDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

/** Parses a decimal string into a Decimal. Throws if the string is not a valid DecimalString. */
export function toDecimal(s: string): Decimal {
  return new MithraDecimal(DecimalString.parse(s));
}

/** Formats a Decimal as a string with exactly 10 fraction digits. */
export function formatDecimal(d: Decimal): string {
  return new MithraDecimal(d).toFixed(SCALE, Decimal.ROUND_HALF_EVEN);
}

/** Sums decimal strings exactly and returns the total with exactly 10 fraction digits. */
export function sumDecimals(strings: readonly string[]): string {
  const total = strings.reduce((acc, s) => acc.plus(toDecimal(s)), new MithraDecimal(0));
  return formatDecimal(total);
}
