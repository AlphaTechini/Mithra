/** Maps server cycle and payment statuses onto the design system's chips. Words come from the chips. */
import type { CycleStatus, CycleSummary, PaymentView } from '@mithra/shared';
import type { ChipKind } from '$lib/types/ui';

export interface CycleChip {
  kind: ChipKind;
  progress?: { signed: number; required: number };
}

/** The chip for a cycle. "Paid" words appear only for statuses the server reports. */
export function cycleChip(cycle: Pick<CycleSummary, 'status' | 'approvals'>): CycleChip {
  const status: CycleStatus = cycle.status;
  switch (status) {
    case 'running':
      return { kind: 'running' };
    case 'countdown':
      return { kind: 'countdown' };
    case 'held':
      return { kind: 'held' };
    case 'awaiting-approval':
      return cycle.approvals
        ? {
            kind: 'awaiting-approval',
            progress: { signed: cycle.approvals.have, required: cycle.approvals.need },
          }
        : { kind: 'awaiting-approval' };
    case 'executing':
      return { kind: 'pending' };
    case 'paid-automatically':
      return { kind: 'paid-auto' };
    case 'paid-after-approval':
      return { kind: 'paid-approved' };
    case 'awaiting-acceptance':
      return { kind: 'awaiting-acceptance' };
    case 'rejected':
      return { kind: 'rejected' };
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'failed':
      return { kind: 'failed' };
    case 'needs-funds':
      return { kind: 'needs-funds' };
  }
}

/** The chip for one payment row. "Pending ledger confirmation" until the server says `paid` (P4). */
export function paymentChip(payment: PaymentView): ChipKind {
  switch (payment.status) {
    case 'pending-ledger':
      return 'pending';
    case 'paid':
      return 'paid';
    case 'awaiting-acceptance':
      return 'awaiting-acceptance';
  }
}

/** Statuses after which nothing more changes without a person acting. */
export function isSettled(status: CycleStatus): boolean {
  return (
    status === 'paid-automatically' ||
    status === 'paid-after-approval' ||
    status === 'rejected' ||
    status === 'cancelled' ||
    status === 'failed'
  );
}

/**
 * Who wrote the memo of a decision, in words. The server sends `ai`, `template` or
 * `ai-unavailable`; anything else (an older record) is shown as it came.
 */
export function memoSourceText(source: string): string {
  switch (source) {
    case 'ai':
      return 'Written by the AI reviewer';
    case 'template':
      return 'Written from the checks';
    case 'ai-unavailable':
      return 'AI review unavailable; written from the checks';
    default:
      return source;
  }
}
