import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import type { ChipKind } from '$lib/types/ui';
import StatusChip from './StatusChip.svelte';

const WORDS: Record<ChipKind, string> = {
  paid: 'Paid',
  'paid-auto': 'Paid automatically',
  'awaiting-approval': 'Awaiting approval 1 of 2',
  'awaiting-acceptance': 'Awaiting acceptance',
  pending: 'Pending ledger confirmation',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  flagged: 'Flagged',
  passed: 'Passed',
  active: 'Active until Oct 14',
  expired: 'Access ended Oct 14',
  denied: 'Request denied',
  seeded: 'Seeded',
  'paid-approved': 'Paid after approval',
  running: 'Running',
  countdown: 'Executing soon',
  held: 'On hold',
  failed: 'Failed',
  'needs-funds': 'Needs funds',
  advisory: 'Advisory',
  'auto-on': 'Auto-receive on',
  'auto-off': 'Auto-receive off',
  online: 'Online',
  offline: 'Offline',
  confirmed: 'Confirmed',
  waiting: 'Waiting',
  approved: 'Approved',
  'awaiting-signature': 'Awaiting your signature in Grofty',
  'needs-wallets': 'Waiting for holders to connect Grofty',
  'waiting-treasurer': 'Waiting for the treasurer',
  withdrawn: 'Request withdrawn',
};

describe('StatusChip', () => {
  it.each(Object.entries(WORDS) as [ChipKind, string][])(
    '%s renders an icon and a word',
    (kind, word) => {
      const { container } = render(StatusChip, {
        kind,
        progress: { signed: 1, required: 2 },
        date: '2026-10-14T12:00:00Z',
      });
      expect(container.querySelector('svg[data-icon]')).not.toBeNull();
      expect(container.textContent?.trim()).toBe(word);
    },
  );

  it('uses a different icon for statuses that share a colour', () => {
    const icons = new Set(
      (['paid', 'paid-auto', 'passed', 'active'] as ChipKind[]).map((kind) => {
        const { container } = render(StatusChip, { kind });
        return container.querySelector('svg')?.getAttribute('data-icon');
      }),
    );
    expect(icons.size).toBe(4);
  });
});
