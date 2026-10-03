import { createHash } from 'node:crypto';

/** JSON with sorted keys and no whitespace, so equal values always give the same text. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

/** SHA-256 of UTF-8 text as lowercase hex. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** SHA-256 hex of the canonical JSON of `value` (L10 input fingerprints). */
export function fingerprint(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
