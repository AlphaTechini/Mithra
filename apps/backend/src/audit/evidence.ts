import {
  sumDecimals,
  type EvidenceRecord,
  type EvidenceRoom,
  type RecordPreview,
  type TxLink,
} from '@mithra/shared';
import type { Config } from '../config/env';
import { txLinkFor } from '../cycle/links';
import { formatAmount, plural, showAmountText } from '../cycle/format';
import type { DecisionRecord, DistributionOutcome, Evidence } from '../ledger';
import { compareRecordIds, isFlagged, labelForRecordId } from './catalog';

/**
 * Pure mappers from what the ledger shares (the `Evidence` of a `SharedRecord`) to the evidence
 * room's view (L8), and from treasury-side records to the treasurer's preview. Nothing here reads
 * a ledger, a database or a clock.
 */

/** "Holder A" for 0, "Holder B" for 1 ... "Holder Z", then "Holder AA", "Holder AB" ... */
export function holderLabel(index: number): string {
  let n = index;
  let letters = '';
  do {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `Holder ${letters}`;
}

/** The holders a shared record names (payouts of a decision, payments of an outcome). */
export function holdersOf(evidence: Evidence): string[] {
  return evidence.tag === 'EvDecision'
    ? evidence.value.payouts.map((p) => p.holder)
    : evidence.value.payments.map((p) => p.holder);
}

/** The approvers an outcome records; none for a decision record. */
export function approversOf(evidence: Evidence): string[] {
  return evidence.tag === 'EvOutcome' ? evidence.value.approvals.map((a) => a.approver) : [];
}

/** The payment contracts an outcome refers to, for the payment links. */
export function paymentCidsOf(evidence: Evidence): string[] {
  return evidence.tag === 'EvOutcome' ? evidence.value.payments.map((p) => p.paymentCid) : [];
}

/**
 * Labels for the holders of one grant: "Holder A", "Holder B" ... in party-id order across every
 * record of the grant, so the same holder has the same label in every record, and the label says
 * nothing about who the holder is.
 */
export function holderLabelsFor(evidence: readonly Evidence[]): Map<string, string> {
  const parties = [...new Set(evidence.flatMap(holdersOf))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return new Map(parties.map((party, index) => [party, holderLabel(index)]));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A function that replaces every key of `replacements` in a text by its value, in one pass (so a
 * replacement is never replaced again). Keys match whole words only. The decision record's memo and
 * checks are written for the treasury and name holders; this keeps those names out of the evidence.
 */
export function createRedactor(
  replacements: ReadonlyMap<string, string>,
): (text: string) => string {
  const keys = [...replacements.keys()].filter((k) => k !== '').sort((a, b) => b.length - a.length);
  if (keys.length === 0) return (text) => text;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${keys.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`,
    'gu',
  );
  return (text) => text.replace(pattern, (match) => replacements.get(match) ?? match);
}

/** The link of a payment's transaction for an auditor: the explorer on MainNet, the auditor page on LocalNet. */
export function auditorTxLink(
  config: Pick<Config, 'network' | 'mainnet'>,
  updateId: string,
): TxLink {
  if (config.network === 'mainnet' && config.mainnet) return txLinkFor(config, updateId);
  return { updateId, href: `/auditor/tx/${encodeURIComponent(updateId)}`, external: false };
}

/** What the mappers need besides the evidence itself. */
export interface EvidenceContext {
  /** Holder party → "Holder A" (see `holderLabelsFor`). */
  holderLabels: ReadonlyMap<string, string>;
  /** Display name of an approver (approvers are the fund's staff, not holders). */
  approverName(party: string): string;
  /** Update id of a payment's transaction, from `tx_refs`; null when unknown. */
  updateIdOf(paymentCid: string): string | null;
  linkFor(updateId: string): TxLink;
  /** Removes holder names and ids from free text. */
  redact(text: string): string;
}

const TRIGGER_LABELS = {
  TriggerSchedule: 'Schedule',
  TriggerPrompt: 'Prompt',
  TriggerManual: 'Manual run',
} as const;

const UNKNOWN_HOLDER = 'Another holder';

function labelOfHolder(ctx: EvidenceContext, party: string): string {
  return ctx.holderLabels.get(party) ?? UNKNOWN_HOLDER;
}

function byLabel<T extends { holderLabel: string }>(a: T, b: T): number {
  return a.holderLabel < b.holderLabel
    ? -1
    : a.holderLabel > b.holderLabel
      ? 1
      : a.holderLabel.length - b.holderLabel.length;
}

export function mapDecisionEvidence(
  d: DecisionRecord,
  ctx: EvidenceContext,
): NonNullable<EvidenceRecord['decision']> {
  const trigger = TRIGGER_LABELS[d.trigger];
  return {
    trigger: d.triggerDetail ? `${trigger}: ${ctx.redact(d.triggerDetail)}` : trigger,
    recordDate: d.recordDate,
    total: d.total,
    payouts: d.payouts
      .map((p) => ({
        holderLabel: labelOfHolder(ctx, p.holder),
        units: p.units,
        amount: p.amount,
      }))
      .sort(byLabel),
    inputFingerprints: d.inputFingerprints.map((f) => ({ label: f.label, sha256: f.sha256 })),
    modelFingerprints: d.modelFingerprints.map((f) => ({ label: f.label, sha256: f.sha256 })),
    checks: d.checks.map((c) => ({
      label: ctx.redact(c.label),
      passed: c.passed,
      blocking: c.blocking,
      actual: ctx.redact(c.actual),
      limit: ctx.redact(c.limit),
      source: c.source,
    })),
    memo: ctx.redact(d.memo),
    verdict: d.verdict === 'AutoExecute' ? 'within-mandate' : 'needs-approval',
    mandateVersion: d.mandateVersion,
    cap: d.cap,
    createdAt: d.createdAt,
  };
}

const OUTCOME_KINDS = {
  Executed: 'executed',
  Rejected: 'rejected',
  Cancelled: 'cancelled',
} as const;

const PAYMENT_STATUSES = { Paid: 'paid', AwaitingAcceptance: 'awaiting-acceptance' } as const;

export function mapOutcomeEvidence(
  o: DistributionOutcome,
  ctx: EvidenceContext,
): NonNullable<EvidenceRecord['outcome']> {
  return {
    kind: OUTCOME_KINDS[o.kind],
    approvals: o.approvals.map((a) => ({
      approverLabel: ctx.approverName(a.approver),
      at: a.at,
      note: ctx.redact(a.note),
    })),
    payments: o.payments
      .map((p) => {
        const updateId = ctx.updateIdOf(p.paymentCid);
        return {
          holderLabel: labelOfHolder(ctx, p.holder),
          amount: p.amount,
          status: PAYMENT_STATUSES[p.status],
          link: updateId ? ctx.linkFor(updateId) : null,
        };
      })
      .sort(byLabel),
    reason: o.reason === null || o.reason === undefined ? null : ctx.redact(o.reason),
    at: o.at,
  };
}

/** One shared record as the evidence room shows it. */
export function toEvidenceRecord(evidence: Evidence, ctx: EvidenceContext): EvidenceRecord {
  if (evidence.tag === 'EvDecision') {
    const d = evidence.value;
    return {
      recordId: d.recordId,
      kind: 'decision',
      cycleLabel: d.cycleLabel,
      decision: mapDecisionEvidence(d, ctx),
      outcome: null,
    };
  }
  const o = evidence.value;
  return {
    recordId: o.recordId,
    kind: 'outcome',
    cycleLabel: o.cycleLabel,
    decision: null,
    outcome: mapOutcomeEvidence(o, ctx),
  };
}

/** The records of a grant, mapped and ordered by cycle (decision before outcome). */
export function toEvidenceRecords(
  evidence: readonly Evidence[],
  ctx: EvidenceContext,
): EvidenceRecord[] {
  return evidence
    .map((e) => toEvidenceRecord(e, ctx))
    .sort((a, b) => compareRecordIds(a.recordId, b.recordId));
}

// Treasurer preview -----------------------------------------------------------------------------

function approvalPart(outcome: DistributionOutcome | null, approverCount: number): string {
  if (!outcome || outcome.approvals.length === 0) return '';
  return `, approved ${outcome.approvals.length} of ${approverCount}`;
}

/**
 * The treasurer's one-line summary of a decision record, for example
 * "1,200 CC to 4 holders, flagged, approved 2 of 3". `outcome` is the outcome of the same
 * decision, when there is one: it adds the approvals.
 */
export function previewDecision(
  d: DecisionRecord,
  outcome: DistributionOutcome | null,
  symbol: string,
): RecordPreview {
  const flagged = isFlagged(d) ? 'flagged' : 'within mandate';
  return {
    recordId: d.recordId,
    kind: 'decision',
    label: labelForRecordId(d.recordId),
    summary: `${formatAmount(d.total, symbol)} to ${plural(d.payouts.length, 'holder')}, ${flagged}${approvalPart(outcome, d.approvers.length)}`,
    available: true,
  };
}

/** The one-line summary of an outcome; `decision` is its decision record, when known. */
export function previewOutcome(
  o: DistributionOutcome,
  decision: DecisionRecord | null,
  symbol: string,
): RecordPreview {
  let summary: string;
  if (o.kind === 'Executed') {
    const flagged = decision ? (isFlagged(decision) ? ', flagged' : ', within mandate') : '';
    summary = `Executed: ${formatAmount(sumDecimals(o.payments.map((p) => p.amount)), symbol)} to ${plural(o.payments.length, 'holder')}${flagged}${approvalPart(o, o.approvers.length)}`;
  } else if (o.kind === 'Rejected') {
    summary = `Rejected${o.reason ? `: ${o.reason}` : ''}${approvalPart(o, o.approvers.length)}`;
  } else {
    summary = `Cancelled${o.reason ? `: ${o.reason}` : ' by the treasurer'}`;
  }
  return {
    recordId: o.recordId,
    kind: 'outcome',
    label: labelForRecordId(o.recordId),
    summary,
    available: true,
  };
}

/** A scope item whose record is no longer on the ledger. */
export function previewUnavailable(item: {
  recordId: string;
  kind: 'decision' | 'outcome';
}): RecordPreview {
  return {
    recordId: item.recordId,
    kind: item.kind,
    label: labelForRecordId(item.recordId),
    summary: 'This record is no longer on the ledger and cannot be shared.',
    available: false,
  };
}

// Working-paper export ----------------------------------------------------------------------------

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function dateOf(iso: string): string {
  return iso.slice(0, 10);
}

function amountOf(value: string): string {
  return showAmountText(value);
}

/**
 * The evidence room as Markdown for working papers: the question, the grant dates, and for each
 * record its fields, fingerprints, approvals and payments with holder labels.
 */
export function evidenceMarkdown(room: EvidenceRoom, symbol: string): string {
  const lines: string[] = [];
  lines.push('# Mithra evidence summary', '');
  lines.push(`- Question: ${room.question.replace(/\r?\n/g, ' ')}`);
  lines.push(`- Grant: ${room.grantId}`);
  lines.push(`- Access granted: ${room.grantedAt}`);
  lines.push(`- Access expires: ${room.expiresAt}`);
  lines.push(`- Records: ${room.records.length}`);
  lines.push(
    '- Holders are labelled Holder A, Holder B ... in the same way in every record of this grant.',
    '',
  );
  for (const record of room.records) {
    lines.push(`## ${labelForRecordId(record.recordId)}`, '');
    lines.push(`Record id: \`${record.recordId}\``, '');
    const d = record.decision;
    if (d) {
      lines.push(`- Cycle: ${record.cycleLabel}`);
      lines.push(`- Trigger: ${d.trigger}`);
      lines.push(`- Record date: ${d.recordDate}`);
      lines.push(`- Total: ${amountOf(d.total)} ${symbol}`);
      lines.push(
        `- Verdict: ${d.verdict === 'within-mandate' ? 'within mandate' : 'needs approval'} (Mandate version ${d.mandateVersion}, cap ${amountOf(d.cap)} ${symbol})`,
      );
      lines.push(`- Created: ${d.createdAt}`, '');
      lines.push('### Payouts', '', '| Holder | Units | Amount |', '| --- | ---: | ---: |');
      for (const p of d.payouts) {
        lines.push(`| ${cell(p.holderLabel)} | ${p.units} | ${amountOf(p.amount)} ${symbol} |`);
      }
      lines.push('', '### Checks', '');
      for (const c of d.checks) {
        lines.push(
          `- ${c.passed ? 'Passed' : c.blocking ? 'Flagged' : 'Advisory'}: ${c.label} (${c.source}). ${c.actual}. Limit: ${c.limit}`,
        );
      }
      lines.push('', '### Fingerprints (SHA-256)', '');
      for (const f of d.inputFingerprints) lines.push(`- Input, ${f.label}: \`${f.sha256}\``);
      for (const f of d.modelFingerprints) lines.push(`- Model, ${f.label}: \`${f.sha256}\``);
      lines.push('', '### Memo', '');
      for (const line of d.memo.split(/\r?\n/)) lines.push(line === '' ? '' : `> ${line}`);
      lines.push('');
    }
    const o = record.outcome;
    if (o) {
      lines.push(`- Cycle: ${record.cycleLabel}`);
      lines.push(`- Outcome: ${o.kind}${o.reason ? ` (${o.reason})` : ''}`);
      lines.push(`- At: ${o.at}`, '');
      lines.push('### Approvals', '');
      if (o.approvals.length === 0) lines.push('None recorded.');
      for (const a of o.approvals) {
        lines.push(`- ${a.approverLabel}, ${dateOf(a.at)}${a.note ? `: ${a.note}` : ''}`);
      }
      lines.push('', '### Payments', '');
      if (o.payments.length === 0) {
        lines.push('None.');
      } else {
        lines.push('| Holder | Amount | Status | Transaction |', '| --- | ---: | --- | --- |');
        for (const p of o.payments) {
          lines.push(
            `| ${cell(p.holderLabel)} | ${amountOf(p.amount)} ${symbol} | ${p.status} | ${p.link ? p.link.href : 'n/a'} |`,
          );
        }
      }
      lines.push('');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
