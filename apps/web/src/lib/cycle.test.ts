import { describe, expect, it } from 'vitest';
import { cycleChip, isSettled, paymentChip } from './cycle';

describe('MainNet statuses', () => {
  it('maps awaiting-signature and needs-wallets onto their own chips, never onto a paid one', () => {
    expect(cycleChip({ status: 'awaiting-signature', approvals: null })).toEqual({
      kind: 'awaiting-signature',
    });
    expect(cycleChip({ status: 'needs-wallets', approvals: null })).toEqual({
      kind: 'needs-wallets',
    });
  });

  it('keeps those cycles open: a person still has to act', () => {
    expect(isSettled('awaiting-signature')).toBe(false);
    expect(isSettled('needs-wallets')).toBe(false);
  });

  it('shows a payment as pending until the server says paid (P4)', () => {
    expect(paymentChip({ status: 'pending-ledger', link: null })).toBe('pending');
    expect(paymentChip({ status: 'paid', link: null })).toBe('paid');
  });
});
