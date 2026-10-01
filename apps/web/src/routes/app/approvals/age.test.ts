import { describe, expect, it } from 'vitest';
import { formatAge } from './age';

const NOW = new Date('2026-10-01T12:00:00Z');

describe('formatAge', () => {
  it.each([
    ['2026-10-01T11:59:40Z', 'just now'],
    ['2026-10-01T11:59:00Z', '1 minute ago'],
    ['2026-10-01T11:15:00Z', '45 minutes ago'],
    ['2026-10-01T11:00:00Z', '1 hour ago'],
    ['2026-10-01T02:00:00Z', '10 hours ago'],
    ['2026-09-29T12:00:00Z', '2 days ago'],
  ])('%s is %s', (iso, expected) => {
    expect(formatAge(iso, NOW)).toBe(expected);
  });

  it('treats a time in the future as just now and bad input as empty', () => {
    expect(formatAge('2026-10-02T00:00:00Z', NOW)).toBe('just now');
    expect(formatAge('nonsense', NOW)).toBe('');
  });
});
