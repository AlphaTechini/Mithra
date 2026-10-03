import type { CheckResult, Fingerprint } from '../ledger';
import { cycleLabel as labelOf } from './period';
import { formatAmount, plural, shortDate } from './format';
import type { HistoryEntry } from './checks';

/** What a memo writer gets to read. Everything in it was computed by code (A3, A4). */
export interface MemoInput {
  cycleId: string;
  cycleLabel: string;
  recordDate: string;
  /** Decimal string; never changed by a writer. */
  total: string;
  assetSymbol: string;
  trigger: 'schedule' | 'prompt' | 'manual';
  triggerDetail: string;
  /** The prompt that asked for this cycle, when the trigger is a prompt. */
  promptText: string | null;
  payouts: {
    holder: string;
    displayName: string;
    units: number;
    sharePct: string;
    amount: string;
  }[];
  /** The deterministic checks as the engine ran them, with actual values. */
  checks: readonly CheckResult[];
  /** Executed cycles before this one, newest first. */
  history: readonly HistoryEntry[];
  /** Holders whose units changed in the unit-change window before the record date. */
  holderChanges: {
    holder: string;
    displayName: string;
    unitsBefore: number;
    unitsAfter: number;
  }[];
  /** What the Mandate will decide, from the same rule it applies on the ledger. */
  verdict: 'within-mandate' | 'needs-approval';
  verdictReasons: readonly string[];
  mandate: { version: number; cap: string; approvalThreshold: number; approverCount: number };
}

export type MemoSource = 'ai' | 'template' | 'ai-unavailable';

export interface MemoResult {
  memo: string;
  memoSource: MemoSource;
  /**
   * Advisory flags raised by a language model. The engine keeps only checks with source `ai` that
   * are not blocking (A5); a writer can never add a blocking check or change a deterministic one.
   */
  advisoryChecks: CheckResult[];
  /** Fingerprints of the model request and response (A12). */
  modelFingerprints: Fingerprint[];
}

/** Writes the plain-English memo for a proposal. The AI writer (M5) and the template writer share this. */
export interface MemoWriter {
  write(input: MemoInput): Promise<MemoResult>;
}

/** Codes of the deterministic checks; an advisory check cannot reuse them. */
export const DETERMINISTIC_CHECK_CODES: ReadonlySet<string> = new Set([
  'cap',
  'balance',
  'non_holder',
  'duplicate_cycle',
  'deviation',
  'unit_spike',
  'prompt_amount',
]);

const MAX_ADVISORY_CHECKS = 5;

/**
 * A5, enforced by the engine: of what a memo writer returns, only checks whose `source` is `ai`
 * and that are not blocking survive, and they cannot reuse the code of a deterministic check. The
 * advisory list is also capped. Everything else is dropped silently; the deterministic checks are
 * never taken from a writer at all.
 */
export function sanitizeAdvisoryChecks(checks: readonly CheckResult[]): CheckResult[] {
  return checks
    .filter((c) => c.source === 'ai' && !c.blocking && !DETERMINISTIC_CHECK_CODES.has(c.code))
    .slice(0, MAX_ADVISORY_CHECKS)
    .map((c) => ({
      code: c.code === '' ? 'ai_advisory' : c.code,
      label: c.label,
      passed: c.passed,
      blocking: false,
      actual: c.actual,
      limit: c.limit,
      source: 'ai',
    }));
}

/**
 * The memo without a language model: deterministic plain English built from the same facts the
 * agent has. Names every failed check with its actual values.
 */
export class TemplateMemoWriter implements MemoWriter {
  write(input: MemoInput): Promise<MemoResult> {
    return Promise.resolve({
      memo: templateMemo(input),
      memoSource: 'template',
      advisoryChecks: [],
      modelFingerprints: [],
    });
  }
}

export function templateMemo(input: MemoInput): string {
  const symbol = input.assetSymbol;
  const label = input.cycleLabel || labelOf(input.cycleId);
  const paragraphs: string[] = [];

  const largest = input.payouts.reduce<MemoInput['payouts'][number] | null>(
    (max, p) => (max === null || p.units > max.units ? p : max),
    null,
  );
  let split = `${label}: ${formatAmount(input.total, symbol)} is split pro rata over ${plural(input.payouts.length, 'holder')} by the units they held on ${shortDate(input.recordDate)}, the record date.`;
  if (largest) {
    split += ` The largest payment is ${formatAmount(largest.amount, symbol)} to ${largest.displayName} (${largest.sharePct}% of units).`;
  }
  paragraphs.push(split);

  const failed = input.checks.filter((c) => !c.passed);
  if (failed.length === 0) {
    paragraphs.push(
      input.checks.length === 0
        ? 'No checks were run.'
        : input.checks.length === 1
          ? 'The 1 check passed.'
          : `All ${input.checks.length} checks passed.`,
    );
  } else {
    const lines = failed.map((c) => `- ${c.label}: ${c.actual}`);
    paragraphs.push(
      `${failed.length} of ${plural(input.checks.length, 'check')} flagged:\n${lines.join('\n')}`,
    );
  }

  if (input.history.length > 0) {
    const past = input.history
      .map((h) => `${labelOf(h.cycleId)} ${formatAmount(h.total, symbol)}`)
      .join(', ');
    paragraphs.push(`Earlier cycles: ${past}.`);
  }
  if (input.holderChanges.length > 0) {
    const changes = input.holderChanges
      .map(
        (c) =>
          `${c.displayName} ${c.unitsBefore} → ${c.unitsAfter} ${c.unitsAfter === 1 ? 'unit' : 'units'}`,
      )
      .join(', ');
    paragraphs.push(`Unit changes in the window before the record date: ${changes}.`);
  }

  if (input.verdict === 'within-mandate') {
    paragraphs.push(
      `This is within the mandate (cap ${formatAmount(input.mandate.cap, symbol)}). It will be paid automatically after a short countdown; use Hold to stop it.`,
    );
  } else {
    const reasons = input.verdictReasons.length > 0 ? ` ${input.verdictReasons.join('; ')}.` : '';
    paragraphs.push(
      `This needs ${input.mandate.approvalThreshold} of ${plural(input.mandate.approverCount, 'approval')} before it is paid.${reasons}`,
    );
  }
  return paragraphs.join('\n\n');
}
