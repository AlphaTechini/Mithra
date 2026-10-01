<script lang="ts">
  /**
   * Status as icon + word, never colour alone. The word is fixed per kind (vocabulary in
   * userflow.md); `progress` and `date` fill the variable parts ("Awaiting approval 1 of 2",
   * "Active until Oct 14"). Not interactive, so no keyboard behaviour.
   */
  import { formatShortDate } from '$lib/format';
  import type { ChipKind } from '$lib/types/ui';
  import Icon, { type IconName } from './Icon.svelte';

  interface Props {
    kind: ChipKind;
    /** `awaiting-approval`: signatures so far and required. */
    progress?: { signed: number; required: number };
    /** `active`: when access ends. `expired`: when it ended. */
    date?: Date | string | number;
  }

  let { kind, progress, date }: Props = $props();

  type Tone = 'success' | 'danger' | 'info' | 'neutral';
  const META: Record<ChipKind, { icon: IconName; tone: Tone }> = {
    paid: { icon: 'check-circle', tone: 'success' },
    'paid-auto': { icon: 'check-double', tone: 'success' },
    'awaiting-approval': { icon: 'hourglass', tone: 'info' },
    'awaiting-acceptance': { icon: 'mail', tone: 'info' },
    pending: { icon: 'clock', tone: 'neutral' },
    rejected: { icon: 'x-circle', tone: 'danger' },
    cancelled: { icon: 'ban', tone: 'neutral' },
    flagged: { icon: 'flag', tone: 'danger' },
    passed: { icon: 'shield', tone: 'success' },
    active: { icon: 'key', tone: 'success' },
    expired: { icon: 'key-off', tone: 'danger' },
    denied: { icon: 'ban', tone: 'danger' },
    seeded: { icon: 'tag', tone: 'neutral' },
  };

  const text = $derived.by(() => {
    const when = date === undefined ? '' : formatShortDate(date);
    switch (kind) {
      case 'paid':
        return 'Paid';
      case 'paid-auto':
        return 'Paid automatically';
      case 'awaiting-approval':
        return progress
          ? `Awaiting approval ${progress.signed} of ${progress.required}`
          : 'Awaiting approval';
      case 'awaiting-acceptance':
        return 'Awaiting acceptance';
      case 'pending':
        return 'Pending ledger confirmation';
      case 'rejected':
        return 'Rejected';
      case 'cancelled':
        return 'Cancelled';
      case 'flagged':
        return 'Flagged';
      case 'passed':
        return 'Passed';
      case 'active':
        return when ? `Active until ${when}` : 'Active';
      case 'expired':
        return when ? `Access ended ${when}` : 'Access ended';
      case 'denied':
        return 'Request denied';
      case 'seeded':
        return 'Seeded';
    }
  });
</script>

<span class="chip {META[kind].tone}" data-kind={kind}>
  <Icon name={META[kind].icon} size={14} />
  <span>{text}</span>
</span>

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: 0.125rem var(--space-2);
    border-radius: var(--radius-pill);
    font-size: var(--text-13);
    font-weight: 500;
    line-height: 1.4;
    white-space: nowrap;
  }
  .success {
    background: var(--color-success-bg);
    color: var(--color-success-text);
  }
  .danger {
    background: var(--color-danger-bg);
    color: var(--color-danger-text);
  }
  .info {
    background: var(--color-info-bg);
    color: var(--color-info-text);
  }
  .neutral {
    background: var(--color-neutral-bg);
    color: var(--color-neutral-text);
  }
</style>
