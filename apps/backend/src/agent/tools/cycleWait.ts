import type { CycleDetail } from '@mithra/shared';
import { toDecimal } from '@mithra/shared';
import { formatAmount } from '../format';
import type { AgentServices } from '../services';

/** Polls until the cycle has a proposal, has failed, or `timeoutMs` has passed. */
export async function waitForProposal(
  services: AgentServices,
  cycleId: string,
  options: { timeoutMs: number; pollMs: number },
): Promise<CycleDetail | null> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const detail = await services.cycles.getCycle(cycleId);
    if (detail && (detail.proposal !== null || detail.error !== null)) return detail;
    if (detail && ['failed', 'rejected', 'cancelled'].includes(detail.summary.status))
      return detail;
    if (Date.now() >= deadline) return detail;
    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
}

/** What the model may know about a cycle: everything shown on the cycle page, nothing more. */
export function cycleFacts(detail: CycleDetail, assetSymbol: string): Record<string, unknown> {
  const p = detail.proposal;
  return {
    cycleId: detail.summary.cycleId,
    label: detail.summary.label,
    status: detail.summary.status,
    trigger: detail.summary.trigger,
    error: detail.error,
    fundsShortfall: detail.fundsShortfall,
    proposal: p
      ? {
          total: `${formatAmount(p.total)} ${assetSymbol}`,
          recordDate: p.recordDate,
          verdict: p.verdict,
          verdictReasons: p.verdictReasons,
          approvals: {
            have: p.approvals.length,
            need: p.approvalThreshold,
            approvers: p.approvers.length,
          },
          payouts: p.payouts.map((r) => ({
            holder: r.holder.displayName,
            units: r.units,
            sharePct: r.sharePct,
            amount: `${formatAmount(r.amount)} ${assetSymbol}`,
          })),
          checks: p.checks.map((c) => ({
            check: c.label,
            result: c.passed ? 'passed' : 'FLAGGED',
            blocking: c.blocking,
            actual: c.actual,
            limit: c.limit,
            source: c.source,
          })),
          memo: p.memo,
          memoSource: p.memoSource,
        }
      : null,
    outcome: detail.outcome
      ? { kind: detail.outcome.kind, reason: detail.outcome.reason, at: detail.outcome.at }
      : null,
  };
}

/** True when the total is above the cap, compared in code. */
export function isAboveCap(total: string, cap: string): boolean {
  return toDecimal(total).gt(toDecimal(cap));
}
