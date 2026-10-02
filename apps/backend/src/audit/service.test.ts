import { describe, expect, it } from 'vitest';
import {
  GRANT_DURATIONS_MS,
  REQUEST_ID_PATTERN,
  deriveStatus,
  expiresAtFor,
  grantIdOf,
  longDate,
  newRequestId,
  normalizeGrantId,
  type StatusFacts,
} from './service';

describe('request ids', () => {
  it('are audit-<yyyymmdd>-<6 characters>', () => {
    const id = newRequestId(new Date('2026-10-01T23:59:00Z'));
    expect(id).toMatch(REQUEST_ID_PATTERN);
    expect(id.startsWith('audit-20261001-')).toBe(true);
  });

  it('use the picked characters and differ between calls', () => {
    const fixed = newRequestId(new Date('2026-01-02T00:00:00Z'), () => 0);
    expect(fixed).toBe('audit-20260102-aaaaaa');
    const last = newRequestId(new Date('2026-01-02T00:00:00Z'), (n) => n - 1);
    expect(last).toBe('audit-20260102-999999');
    expect(newRequestId(new Date())).not.toBe(newRequestId(new Date()));
  });

  it('give grant ids the ledger uses, with or without the prefix', () => {
    expect(grantIdOf('audit-20261001-abc123')).toBe('grant/audit-20261001-abc123');
    expect(normalizeGrantId('grant/audit-20261001-abc123')).toBe('grant/audit-20261001-abc123');
    expect(normalizeGrantId('audit-20261001-abc123')).toBe('grant/audit-20261001-abc123');
  });
});

describe('expiresIn math', () => {
  const now = new Date('2026-10-01T12:00:00.000Z');
  it('adds 24 hours, 7 days or 30 days', () => {
    expect(expiresAtFor('24h', now).toISOString()).toBe('2026-10-02T12:00:00.000Z');
    expect(expiresAtFor('7d', now).toISOString()).toBe('2026-10-08T12:00:00.000Z');
    expect(expiresAtFor('30d', now).toISOString()).toBe('2026-10-31T12:00:00.000Z');
    expect(GRANT_DURATIONS_MS['24h']).toBe(86_400_000);
  });

  it('takes other durations for tests', () => {
    expect(expiresAtFor('24h', now, { '24h': 2000, '7d': 1, '30d': 1 }).toISOString()).toBe(
      '2026-10-01T12:00:02.000Z',
    );
  });
});

describe('status derivation', () => {
  const now = new Date('2026-10-01T12:00:00.000Z');
  const none: StatusFacts = { requestActive: false, grant: null, closed: false, denied: false };
  it('is pending while the request is active', () => {
    expect(deriveStatus({ ...none, requestActive: true }, now)).toBe('pending');
  });
  it('is granted while the grant is active and before its expiry', () => {
    expect(deriveStatus({ ...none, grant: { expiresAt: '2026-10-02T00:00:00Z' } }, now)).toBe(
      'granted',
    );
  });
  it('is ended past the expiry even before the grant is closed, and once closed', () => {
    expect(deriveStatus({ ...none, grant: { expiresAt: '2026-10-01T12:00:00.000Z' } }, now)).toBe(
      'ended',
    );
    expect(deriveStatus({ ...none, closed: true }, now)).toBe('ended');
  });
  it('is denied after a denial, and withdrawn when nothing is left', () => {
    expect(deriveStatus({ ...none, denied: true }, now)).toBe('denied');
    expect(deriveStatus(none, now)).toBe('withdrawn');
  });
});

describe('dates', () => {
  it('are written as day, month name and year in UTC', () => {
    expect(longDate('2026-10-08T23:30:00Z')).toBe('8 October 2026');
    expect(longDate('not a date')).toBe('not a date');
  });
});
