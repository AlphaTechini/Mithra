import {
  formatDecimal,
  type ApprovalsInbox,
  type CheckView,
  type CycleDetail,
  type CycleStatus,
  type CycleSummary,
  type DecisionRecordView,
  type PartyRef,
  type PayoutRow,
  type PaymentView,
  type TimelineStep,
  type TxLink,
} from '@mithra/shared';
import { toDecimal } from '@mithra/shared';
import type {
  CheckResult,
  Contract,
  DecisionRecord,
  DistributionOutcome,
  Mandate,
  Payment,
  Proposal,
} from '../ledger';
import { D, formatAmount } from './format';
import { cycleLabel } from './period';

/**
 * Everything the cycle views need, read from the ledger and the `cycle_runs` row. The functions in
 * this file are pure: they decide the status of a cycle (P4: "Paid" only from ledger contracts) and
 * shape the API responses.
 */

/** A row of `cycle_runs`, as far as the views need it. */
export interface RunState {
  status:
    | 'running'
    | 'proposed'
    | 'executed'
    | 'failed'
    | 'held'
    | 'executing'
    | 'rejected'
    | 'cancelled';
  startedAt: Date;
  error: string | null;
  trigger: 'schedule' | 'prompt' | 'manual';
  total: string | null;
  recordDate: string | null;
  executesAt: Date | null;
  held: boolean;
  /** The engine found payees without a MainNet wallet; `needs-wallets` shows only then. */
  waitingForWallets: boolean;
  fundsShortfall: { balance: string; required: string } | null;
}

/** What is known about one cycle: its run row and the contracts of its current attempt. */
export interface CycleFacts {
  cycleId: string;
  row: RunState | null;
  /** Decision record of the current attempt (the active proposal's, else the highest attempt). */
  record: Contract<DecisionRecord> | null;
  /** The active proposal of the cycle, if any. */
  proposal: Contract<Proposal> | null;
  /** Outcome of the current attempt, if it ended. */
  outcome: Contract<DistributionOutcome> | null;
  /** Active Payment contracts of the cycle (one per holder after an execution). */
  payments: Contract<Payment>[];
  /** Number of proposals made for the cycle so far (outcomes of earlier attempts plus this one). */
  attempts: number;
  /**
   * MainNet: payees of the active proposal that have not connected a Grofty wallet yet. The engine
   * fills it in; absent or empty on LocalNet.
   */
  missingWallets?: readonly string[];
}

export interface LedgerFacts {
  mandate: Contract<Mandate> | null;
  proposals: Contract<Proposal>[];
  records: Contract<DecisionRecord>[];
  outcomes: Contract<DistributionOutcome>[];
  payments: Contract<Payment>[];
}

export interface ViewContext {
  now: Date;
  assetSymbol: string;
  refOf(partyId: string): PartyRef;
  /** The update that created or last changed this contract, when the app recorded it. */
  updateIdOf(contractId: string): string | null;
  linkFor(updateId: string): TxLink;
}

const TRIGGERS = {
  TriggerSchedule: 'schedule',
  TriggerPrompt: 'prompt',
  TriggerManual: 'manual',
} as const;

/** The attempt number of a record id like `decision/2026-09/2`. */
export function attemptOf(recordId: string): number {
  const last = recordId.split('/').pop() ?? '';
  const parsed = Number.parseInt(last, 10);
  return Number.isFinite(parsed) ? parsed : 1;
}

/** `decision/2026-09/1` -> `proposal/2026-09/1`: both ids share the cycle and attempt. */
export function proposalIdOf(decisionRecordId: string): string {
  return decisionRecordId.replace(/^decision\//, 'proposal/');
}

/** Distinct approvers of `approvals` that are in `approvers`: what the ledger counts (U3). */
export function validApprovalCount(
  approvals: readonly { approver: string }[],
  approvers: readonly string[],
): number {
  return new Set(approvals.map((a) => a.approver).filter((a) => approvers.includes(a))).size;
}

function timeMs(iso: string): number {
  return new Date(iso).getTime();
}

/** Groups what the ledger and the run table know into one `CycleFacts` per cycle. */
export function groupCycles(
  rows: ReadonlyMap<string, RunState>,
  ledger: LedgerFacts,
): CycleFacts[] {
  const ids = new Set<string>(rows.keys());
  for (const c of ledger.records) ids.add(c.payload.cycleId);
  for (const c of ledger.proposals) ids.add(c.payload.cycleId);
  for (const c of ledger.outcomes) ids.add(c.payload.cycleId);
  return [...ids].map((cycleId) => {
    const records = ledger.records.filter((r) => r.payload.cycleId === cycleId);
    const proposals = ledger.proposals
      .filter((p) => p.payload.cycleId === cycleId)
      .sort(
        (a, b) => attemptOf(b.payload.decisionRecordId) - attemptOf(a.payload.decisionRecordId),
      );
    // An executed distribution is final (L3): nothing else for the cycle can execute, so it is the
    // current attempt whatever other proposals are still open.
    const executed =
      ledger.outcomes.find((o) => o.payload.cycleId === cycleId && o.payload.kind === 'Executed') ??
      null;
    const proposal = executed ? null : (proposals[0] ?? null);
    const byAttempt = [...records].sort(
      (a, b) => attemptOf(b.payload.recordId) - attemptOf(a.payload.recordId),
    );
    const record =
      (executed && records.find((r) => r.payload.recordId === executed.payload.decisionRecordId)) ||
      (proposal && records.find((r) => r.payload.recordId === proposal.payload.decisionRecordId)) ||
      byAttempt[0] ||
      null;
    const outcome =
      executed ??
      (record
        ? (ledger.outcomes.find((o) => o.payload.decisionRecordId === record.payload.recordId) ??
          null)
        : null);
    return {
      cycleId,
      row: rows.get(cycleId) ?? null,
      record,
      proposal,
      outcome,
      payments: ledger.payments.filter((p) => p.payload.cycleId === cycleId),
      attempts: records.length,
    };
  });
}

function executedStatus(cf: CycleFacts): CycleStatus {
  const statuses =
    cf.payments.length > 0
      ? cf.payments.map((p) => p.payload.status)
      : (cf.outcome?.payload.payments.map((p) => p.status) ?? []);
  // MainNet: the ledger authorized the payout, but a payment is only Paid once its transfer was
  // recorded after Grofty reported it executed (P4).
  if (statuses.includes('PendingExternal')) return 'awaiting-signature';
  if (statuses.includes('AwaitingAcceptance')) return 'awaiting-acceptance';
  const approved =
    cf.record?.payload.verdict === 'NeedsApproval' ||
    (cf.outcome?.payload.approvals.length ?? 0) > 0;
  return approved ? 'paid-after-approval' : 'paid-automatically';
}

/**
 * Payees still lack a MainNet wallet and the engine has recorded that. Without the engine's
 * record the status stays `executing`, so a client that sees `needs-wallets` also finds the
 * activity entry and the timeline step the engine wrote for it.
 */
function waitsForWallets(cf: CycleFacts): boolean {
  return (cf.missingWallets?.length ?? 0) > 0 && cf.row?.waitingForWallets === true;
}

/**
 * The status of a cycle. "Paid" statuses come only from a DistributionOutcome of kind Executed and
 * the Payment contracts (P4); a run row that says `executed` without them never shows as paid.
 */
export function deriveStatus(
  cf: CycleFacts,
  mandate: Contract<Mandate> | null,
  now: Date,
): CycleStatus {
  const { row, proposal, outcome } = cf;
  const rowNewerThanOutcome =
    row !== null &&
    outcome !== null &&
    row.startedAt.getTime() >= timeMs(outcome.payload.at) &&
    (row.status === 'running' || row.status === 'failed');

  if (outcome && !(rowNewerThanOutcome && !proposal)) {
    switch (outcome.payload.kind) {
      case 'Executed':
        // The engine records a payout (timeline, activity, links) before it marks the row
        // executed. Until then the cycle is still executing, so a client that sees it paid also
        // finds everything the engine writes for it.
        return row?.status === 'executing' ? 'executing' : executedStatus(cf);
      case 'Rejected':
        return 'rejected';
      case 'Cancelled':
        return 'cancelled';
    }
  }

  if (proposal) {
    if (row?.status === 'executing') return 'executing';
    const shortfall = row?.fundsShortfall != null;
    if (proposal.payload.verdict === 'AutoExecute') {
      if (row?.status === 'failed') return 'failed';
      if (shortfall) return 'needs-funds';
      if (row?.held) return 'held';
      const due = row?.executesAt != null && row.executesAt.getTime() <= now.getTime();
      if (due && waitsForWallets(cf)) return 'needs-wallets';
      return due ? 'executing' : 'countdown';
    }
    const approvers = mandate?.payload.terms.approvers ?? proposal.payload.approvers;
    const need = mandate?.payload.terms.approvalThreshold ?? proposal.payload.approvalThreshold;
    if (validApprovalCount(proposal.payload.approvals, approvers) < need)
      return 'awaiting-approval';
    if (row?.status === 'failed') return 'failed';
    if (shortfall) return 'needs-funds';
    if (waitsForWallets(cf)) return 'needs-wallets';
    return 'executing';
  }

  switch (row?.status) {
    case 'running':
      return 'running';
    case 'failed':
      return 'failed';
    case 'rejected':
      return 'rejected';
    case 'cancelled':
      return 'cancelled';
    case 'executed':
      // The run table says executed but the outcome is not visible: never show Paid for it.
      return 'executing';
    case 'proposed':
    case 'held':
    case 'executing':
      return 'executing';
    case undefined:
      return 'running';
  }
}

function pct2(units: number, totalUnits: number): string {
  if (totalUnits === 0) return '0.00';
  return new D(units).times(100).div(totalUnits).toFixed(2);
}

function checkViews(checks: readonly CheckResult[]): CheckView[] {
  return checks.map((c) => ({
    code: c.code,
    label: c.label,
    passed: c.passed,
    blocking: c.blocking,
    actual: c.actual,
    limit: c.limit,
    source: c.source === 'ai' ? 'ai' : 'deterministic',
  }));
}

/** Plain-English reasons why a proposal needs approval, from the checks the ledger recorded. */
export function verdictReasons(record: DecisionRecord, symbol: string): string[] {
  if (record.verdict === 'AutoExecute') return [];
  const reasons: string[] = [];
  const overCap = toDecimal(record.total).gt(toDecimal(record.cap));
  for (const check of record.checks) {
    if (!check.blocking || check.passed) continue;
    reasons.push(
      check.code === 'cap'
        ? `Total is above the ${formatAmount(record.cap, symbol)} cap`
        : check.actual,
    );
  }
  if (overCap && !record.checks.some((c) => c.code === 'cap' && !c.passed)) {
    reasons.push(`Total is above the ${formatAmount(record.cap, symbol)} cap`);
  }
  return reasons;
}

function verdictView(
  verdict: 'AutoExecute' | 'NeedsApproval',
): 'within-mandate' | 'needs-approval' {
  return verdict === 'AutoExecute' ? 'within-mandate' : 'needs-approval';
}

export function decisionRecordView(record: DecisionRecord): DecisionRecordView {
  return {
    recordId: record.recordId,
    trigger: TRIGGERS[record.trigger],
    triggerDetail: record.triggerDetail,
    inputFingerprints: record.inputFingerprints,
    modelFingerprints: record.modelFingerprints,
    checks: checkViews(record.checks),
    memo: record.memo,
    memoSource: record.memoSource,
    verdict: verdictView(record.verdict),
    mandateVersion: record.mandateVersion,
    cap: record.cap,
    createdAt: record.createdAt,
  };
}

function approvalsOf(
  cf: CycleFacts,
  mandate: Contract<Mandate> | null,
): { have: number; need: number } | null {
  const verdict = cf.record?.payload.verdict ?? cf.proposal?.payload.verdict;
  if (verdict !== 'NeedsApproval') return null;
  const need =
    mandate?.payload.terms.approvalThreshold ?? cf.proposal?.payload.approvalThreshold ?? 0;
  if (cf.proposal) {
    const approvers = mandate?.payload.terms.approvers ?? cf.proposal.payload.approvers;
    return { have: validApprovalCount(cf.proposal.payload.approvals, approvers), need };
  }
  const approvers = mandate?.payload.terms.approvers ?? cf.record?.payload.approvers ?? [];
  const approvals = cf.outcome?.payload.approvals ?? [];
  return {
    have: approvers.length > 0 ? validApprovalCount(approvals, approvers) : approvals.length,
    need,
  };
}

export function summaryOf(
  cf: CycleFacts,
  mandate: Contract<Mandate> | null,
  ctx: ViewContext,
): CycleSummary {
  const record = cf.record?.payload;
  const status = deriveStatus(cf, mandate, ctx.now);
  return {
    cycleId: cf.cycleId,
    label: record?.cycleLabel ?? cf.proposal?.payload.cycleLabel ?? cycleLabel(cf.cycleId),
    status,
    total: record?.total ?? cf.row?.total ?? null,
    recordDate: record?.recordDate ?? cf.row?.recordDate ?? null,
    approvals: approvalsOf(cf, mandate),
    flagCount: record ? record.checks.filter((c) => !c.passed).length : 0,
    trigger: record ? TRIGGERS[record.trigger] : (cf.row?.trigger ?? 'manual'),
    createdAt: record?.createdAt ?? cf.row?.startedAt.toISOString() ?? ctx.now.toISOString(),
    seeded: record?.seeded ?? cf.proposal?.payload.seeded ?? cf.outcome?.payload.seeded ?? false,
  };
}

function paymentViews(
  cf: CycleFacts,
  status: CycleStatus,
  ctx: ViewContext,
): Map<string, PaymentView> {
  const views = new Map<string, PaymentView>();
  const linkOf = (contractId: string | undefined): TxLink | null => {
    const updateId = contractId ? ctx.updateIdOf(contractId) : null;
    return updateId ? ctx.linkFor(updateId) : null;
  };
  if (status === 'executing') {
    for (const p of cf.record?.payload.payouts ?? []) {
      views.set(p.holder, { status: 'pending-ledger', link: null });
    }
    return views;
  }
  if (cf.outcome?.payload.kind !== 'Executed') return views;
  const refs = new Map(cf.outcome.payload.payments.map((r) => [r.holder, r]));
  for (const payout of cf.record?.payload.payouts ?? cf.outcome.payload.payments) {
    const payment = cf.payments.find((p) => p.payload.holder === payout.holder);
    const ref = refs.get(payout.holder);
    const state = payment?.payload.status ?? ref?.status;
    if (!state) continue;
    // MainNet payments name their transaction themselves (`externalTxRef`, the Grofty update id).
    const external = payment?.payload.externalTxRef;
    views.set(payout.holder, {
      status:
        state === 'Paid'
          ? 'paid'
          : state === 'PendingExternal'
            ? 'pending-ledger'
            : 'awaiting-acceptance',
      link:
        linkOf(payment?.contractId) ??
        linkOf(ref?.paymentCid) ??
        (external ? ctx.linkFor(external) : null),
    });
  }
  return views;
}

export function detailOf(
  cf: CycleFacts,
  mandate: Contract<Mandate> | null,
  ctx: ViewContext,
  timeline: TimelineStep[],
): CycleDetail {
  const summary = summaryOf(cf, mandate, ctx);
  const record = cf.record?.payload;
  const proposal = cf.proposal?.payload;
  const active = proposal !== undefined && cf.outcome === null;
  let proposalView: CycleDetail['proposal'] = null;
  if (record) {
    const totalUnits = record.payouts.reduce((sum, p) => sum + p.units, 0);
    const views = paymentViews(cf, summary.status, ctx);
    const payouts: PayoutRow[] = record.payouts.map((p) => ({
      holder: ctx.refOf(p.holder),
      units: p.units,
      sharePct: pct2(p.units, totalUnits),
      amount: formatDecimal(toDecimal(p.amount)),
      payment: views.get(p.holder) ?? null,
    }));
    const approvals = proposal?.approvals ?? cf.outcome?.payload.approvals ?? [];
    proposalView = {
      proposalId: proposal?.proposalId ?? proposalIdOf(record.recordId),
      total: record.total,
      recordDate: record.recordDate,
      verdict: verdictView(record.verdict),
      verdictReasons: verdictReasons(record, ctx.assetSymbol),
      payouts,
      checks: checkViews(record.checks),
      memo: record.memo,
      memoSource: record.memoSource,
      approvals: approvals.map((a) => ({
        approver: ctx.refOf(a.approver),
        at: a.at,
        note: a.note,
      })),
      approvalThreshold:
        proposal?.approvalThreshold ?? mandate?.payload.terms.approvalThreshold ?? approvals.length,
      approvers: record.approvers.map((p) => ctx.refOf(p)),
      decisionRecordId: record.recordId,
    };
  }
  const outcome = cf.outcome?.payload;
  const shortfall = active ? (cf.row?.fundsShortfall ?? null) : null;
  return {
    summary,
    timeline,
    proposal: proposalView,
    decisionRecord: record ? decisionRecordView(record) : null,
    countdown:
      active && record?.verdict === 'AutoExecute' && cf.row?.executesAt
        ? { executesAt: cf.row.executesAt.toISOString(), held: cf.row.held }
        : null,
    outcome: outcome
      ? {
          kind:
            outcome.kind === 'Executed'
              ? 'executed'
              : outcome.kind === 'Rejected'
                ? 'rejected'
                : 'cancelled',
          actor: ctx.refOf(outcome.actor),
          reason: outcome.reason,
          at: outcome.at,
        }
      : null,
    fundsShortfall: shortfall,
    ...(summary.status === 'needs-wallets'
      ? { needsWallets: (cf.missingWallets ?? []).map((p) => ctx.refOf(p)) }
      : {}),
    error: cf.row?.error ?? null,
  };
}

/** Proposals the approver can still act on: needing approval, below the threshold. */
export function inboxOf(
  facts: CycleFacts[],
  mandate: Contract<Mandate> | null,
  approver: string,
): ApprovalsInbox {
  const pending: ApprovalsInbox['pending'] = [];
  for (const cf of facts) {
    const proposal = cf.proposal?.payload;
    if (!proposal || cf.outcome || proposal.verdict !== 'NeedsApproval') continue;
    if (!proposal.approvers.includes(approver)) continue;
    const counts = approvalsOf(cf, mandate);
    if (!counts || counts.have >= counts.need) continue;
    pending.push({
      cycleId: cf.cycleId,
      proposalId: proposal.proposalId,
      label: proposal.cycleLabel,
      total: proposal.total,
      flagCount: cf.record ? cf.record.payload.checks.filter((c) => !c.passed).length : 0,
      approvals: counts,
      youApproved: proposal.approvals.some((a) => a.approver === approver),
      createdAt: proposal.createdAt,
    });
  }
  pending.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return { pending };
}

/** Parties named by the facts, so names can be resolved once before the views are built. */
export function partiesOf(facts: readonly CycleFacts[]): Set<string> {
  const parties = new Set<string>();
  for (const cf of facts) {
    for (const p of cf.record?.payload.payouts ?? []) parties.add(p.holder);
    for (const p of cf.record?.payload.approvers ?? []) parties.add(p);
    for (const a of cf.proposal?.payload.approvals ?? []) parties.add(a.approver);
    for (const a of cf.outcome?.payload.approvals ?? []) parties.add(a.approver);
    if (cf.outcome) parties.add(cf.outcome.payload.actor);
  }
  return parties;
}

/** The newest event of each timeline step after the last "woke" (the latest attempt), in order. */
export function currentTimeline(events: readonly TimelineStep[]): TimelineStep[] {
  const order = ['woke', 'snapshot', 'amounts', 'checks', 'review', 'verdict', 'execute'];
  let start = 0;
  events.forEach((e, i) => {
    if (e.id === 'woke') start = i;
  });
  const latest = new Map<string, TimelineStep>();
  for (const e of events.slice(start)) latest.set(e.id, e);
  return order.flatMap((id) => {
    const step = latest.get(id);
    return step ? [step] : [];
  });
}
