import { describe, expect, it } from 'vitest';
import { cycleChip, isSettled, paymentChip } from './cycle';
import {
  absoluteUrl,
  formatAge,
  formatClock,
  formatDateTime,
  formatDuration,
  previousMonth,
} from './format';
import { fieldsFromTerms, parseForm, toForm } from './policyForm';
import { mandate, fields } from '../test/treasury/fixtures';

describe('cycle chips', () => {
  it('maps every server status to a chip, with approvals progress', () => {
    expect(cycleChip({ status: 'paid-automatically', approvals: null }).kind).toBe('paid-auto');
    expect(cycleChip({ status: 'paid-after-approval', approvals: null }).kind).toBe(
      'paid-approved',
    );
    expect(cycleChip({ status: 'awaiting-approval', approvals: { have: 1, need: 2 } })).toEqual({
      kind: 'awaiting-approval',
      progress: { signed: 1, required: 2 },
    });
    expect(cycleChip({ status: 'rejected', approvals: null }).kind).toBe('rejected');
    // Executing is not "paid": the ledger has not confirmed yet.
    expect(cycleChip({ status: 'executing', approvals: null }).kind).toBe('pending');
  });

  it('shows a payment as pending until the server says paid', () => {
    expect(paymentChip({ status: 'pending-ledger', link: null })).toBe('pending');
    expect(paymentChip({ status: 'paid', link: null })).toBe('paid');
    expect(paymentChip({ status: 'awaiting-acceptance', link: null })).toBe('awaiting-acceptance');
  });

  it('knows which statuses are settled', () => {
    expect(isSettled('paid-automatically')).toBe(true);
    expect(isSettled('executing')).toBe(false);
    expect(isSettled('awaiting-acceptance')).toBe(false);
  });
});

describe('formatting', () => {
  it('formats times, durations and ages', () => {
    const now = new Date('2026-10-01T12:00:00Z');
    expect(formatDateTime('2026-10-01T09:05:00Z', now)).toBe('Oct 1, 09:05 UTC');
    expect(formatDuration(12_000)).toBe('12 s');
    expect(formatDuration(5 * 60_000)).toBe('5 min');
    expect(formatDuration(5 * 3600_000 + 12 * 60_000)).toBe('5 h 12 min');
    expect(formatDuration(3 * 86_400_000)).toBe('3 days');
    expect(formatDuration(-5)).toBe('0 s');
    expect(formatClock(12_400)).toBe('0:13');
    expect(formatAge('2026-10-01T11:00:00Z', now.getTime())).toBe('1 h ago');
    expect(formatAge('2026-10-01T11:59:50Z', now.getTime())).toBe('just now');
  });

  it('defaults the cycle period to the previous month', () => {
    expect(previousMonth(new Date('2026-10-01T00:00:00Z'))).toBe('2026-09');
    expect(previousMonth(new Date('2027-01-15T00:00:00Z'))).toBe('2026-12');
  });

  it('builds absolute invite links', () => {
    expect(absoluteUrl('/invite/AB12CD')).toBe(`${window.location.origin}/invite/AB12CD`);
  });
});

describe('policy form', () => {
  it('round-trips the fields', () => {
    const result = parseForm(toForm(fields()), fields().approvers);
    expect(result.fields).toEqual(fields());
  });

  it('reports each malformed field', () => {
    const form = {
      ...toForm(fields()),
      cap: 'x',
      approvalThreshold: '9',
      trailingCycles: '0',
      scheduleCron: '* *',
    };
    const result = parseForm(form, fields().approvers);
    expect(result.fields).toBeNull();
    expect(Object.keys(result.errors ?? {}).sort()).toEqual(
      ['approvalThreshold', 'cap', 'scheduleCron', 'trailingCycles'].sort(),
    );
  });

  it('treats an empty fixed amount as none', () => {
    const result = parseForm(
      { ...toForm(fields({ fixedAmount: '1200' })), fixedAmount: '' },
      fields().approvers,
    );
    expect(result.fields?.fixedAmount).toBeNull();
  });

  it('maps mandate terms to editable fields, and refuses a rule it does not know', () => {
    const terms = mandate().terms;
    expect(fieldsFromTerms(terms)?.cap).toBe('5000');
    expect(fieldsFromTerms({ ...terms, recordDateRule: 'something_else' })).toBeNull();
  });
});
