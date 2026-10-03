import { DecimalString } from '@mithra/shared';
import { z } from 'zod';

/**
 * Helpers for Daml-LF JSON, the encoding of the JSON Ledger API v2.
 * Decimal and Int travel as strings; amounts stay strings in application code
 * (`DecimalString`) and are never converted to JS numbers.
 */

/** A Daml `Decimal`/`Numeric` read from the ledger: a decimal string. */
export const LfDecimal = DecimalString;

/** Validates an amount for sending to the ledger. Returns the same string. */
export function encodeDecimal(value: string): string {
  return DecimalString.parse(value);
}

/**
 * A Daml `Int` read from the ledger, as a number. The ledger sends integers as strings; a
 * number is also accepted. Throws on values outside the safe integer range.
 */
export const LfInt = z
  .union([z.string().regex(/^-?\d+$/, 'Expected an integer string'), z.number()])
  .transform((value, ctx): number => {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(n)) {
      ctx.addIssue({ code: 'custom', message: `Integer ${String(value)} is not a safe integer` });
      return z.NEVER;
    }
    return n;
  });

/** Encodes a Daml `Int` for the ledger (a string). Throws if `value` is not a safe integer. */
export function encodeInt(value: number): string {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Expected a safe integer, got ${String(value)}`);
  }
  return String(value);
}

/** A Daml `Date`: "YYYY-MM-DD". */
export const LfDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date YYYY-MM-DD');

/** A Daml `Time`: ISO-8601 instant, kept as a string. */
export const LfTime = z.iso.datetime({ offset: true });

/** Encodes a JS Date or ISO string as a Daml `Time`. */
export function encodeTime(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid time ${String(value)}`);
  return date.toISOString();
}

/** Encodes a JS Date or ISO string as a Daml `Date` ("YYYY-MM-DD", UTC). */
export function encodeDate(value: Date | string): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return encodeTime(value).slice(0, 10);
}

/**
 * A Daml `Optional a` (one level) read from the ledger: the value, or null for `None`. The ledger
 * writes `None` as null at the top level of a payload but omits the field inside nested records
 * (verified on a Canton 3.4 sandbox), so a missing key reads as null too.
 */
export const lfOptional = <T extends z.ZodType>(schema: T) =>
  schema.nullish().transform((value): z.output<T> | null => value ?? null);

/** Encodes `None` as null. */
export function encodeOptional<T, R = T>(
  value: T | null | undefined,
  encode: (v: T) => R = (v) => v as unknown as R,
): R | null {
  return value === null || value === undefined ? null : encode(value);
}

/** A Daml variant: `{ tag, value }`. */
export function encodeVariant<Tag extends string, V>(tag: Tag, value: V): { tag: Tag; value: V } {
  return { tag, value };
}

/** A Daml 2-tuple: `{ _1, _2 }`. */
export function lfTuple2<A extends z.ZodType, B extends z.ZodType>(a: A, b: B) {
  return z.object({ _1: a, _2: b });
}

/** Encodes a 2-tuple. */
export function encodeTuple2<A, B>(a: A, b: B): { _1: A; _2: B } {
  return { _1: a, _2: b };
}

/** A Daml `TextMap a`: a JSON object. */
export const lfTextMap = <T extends z.ZodType>(value: T) => z.record(z.string(), value);

/** Encodes a `TextMap` from a plain object or an iterable of pairs. */
export function encodeTextMap<T>(
  entries: Record<string, T> | Iterable<readonly [string, T]>,
): Record<string, T> {
  return Symbol.iterator in entries ? Object.fromEntries(entries) : { ...entries };
}
