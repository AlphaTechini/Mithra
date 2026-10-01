import { z } from 'zod';
import type { MemoInput, MemoResult, MemoWriter } from '../cycle/memo';
import {
  LlmInvalidOutputError,
  LlmUnavailableError,
  type Llm,
  type LlmTool,
  type LlmTurn,
} from '../llm/client';
import type { CheckResult, Fingerprint } from '../ledger/mithra/templates';
import { cycleLabelOf, formatAmount } from './format';

// The memo contract (MemoInput, MemoResult, MemoWriter) belongs to the cycle engine
// (src/cycle/memo.ts); the AI writer implements it.
export type { MemoInput, MemoResult, MemoWriter };

/** What the model must return from `write_review`. It has no field that could change a check. */
const WriteReviewSchema = z.object({
  memo: z.string().trim().min(1).max(4000),
  advisoryFlags: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(120),
        detail: z.string().trim().min(1).max(500),
      }),
    )
    .max(5)
    .default([]),
});

const WRITE_REVIEW_TOOL: LlmTool = {
  name: 'write_review',
  description:
    'Write the review memo for this proposal and list anything unusual as advisory flags. ' +
    'Advisory flags are notes for people; they never block, approve or clear anything, and ' +
    'you cannot change any check or amount with this tool.',
  parameters: {
    type: 'object',
    properties: {
      memo: {
        type: 'string',
        description:
          'Plain-English review for the approvers: what is being paid, what is unusual and why it matters. ' +
          'Quote numbers only as given in the data.',
      },
      advisoryFlags: {
        type: 'array',
        description: 'Things a person should look at that the deterministic checks do not cover.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Short title of the concern.' },
            detail: { type: 'string', description: 'One or two sentences with the facts.' },
          },
          required: ['label', 'detail'],
          additionalProperties: false,
        },
      },
    },
    required: ['memo', 'advisoryFlags'],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = [
  "You review a treasury's proposed yield distribution for the people who approve it.",
  'The payout amounts and the check results below were computed by code. You do not compute, change or clear them.',
  'Write a short plain-English memo: what is being paid and to whom, which checks flagged and what that means, and anything else unusual in the history or unit changes.',
  'Quote amounts exactly as given. Do not invent numbers, holders or checks.',
  'You may add advisory flags for concerns the checks do not cover. They are notes only; they cannot block or approve anything.',
  'Answer by calling write_review.',
].join('\n');

/** The data the model sees. Everything in it was computed by code. */
function reviewPayload(input: MemoInput): unknown {
  return {
    cycle: input.cycleLabel,
    total: `${formatAmount(input.total)} ${input.assetSymbol}`,
    recordDate: input.recordDate,
    trigger: input.triggerDetail,
    ...(input.promptText === null ? {} : { prompt: input.promptText }),
    payouts: input.payouts.map((p) => ({
      holder: p.displayName,
      units: p.units,
      share: `${p.sharePct}%`,
      amount: `${formatAmount(p.amount)} ${input.assetSymbol}`,
    })),
    checks: input.checks.map((c) => ({
      check: c.label,
      result: c.passed ? 'passed' : c.blocking ? 'FLAGGED (blocking)' : 'flagged',
      actual: c.actual,
      limit: c.limit,
    })),
    previousCycles: input.history.map((h) => ({
      cycle: cycleLabelOf(h.cycleId),
      total: `${formatAmount(h.total)} ${input.assetSymbol}`,
    })),
    unitChanges: input.holderChanges.map((u) => ({
      holder: u.displayName,
      from: u.unitsBefore,
      to: u.unitsAfter,
    })),
    mandate: {
      verdict: input.verdict === 'within-mandate' ? 'within the mandate' : 'needs approval',
      reasons: input.verdictReasons,
      cap: `${formatAmount(input.mandate.cap)} ${input.assetSymbol}`,
      approvals: `${input.mandate.approvalThreshold} of ${input.mandate.approverCount}`,
    },
  };
}

/** The deterministic memo used when no model answered: facts and checks, nothing else. */
export function templateReview(input: MemoInput): string {
  const lines: string[] = [];
  lines.push(
    `${input.cycleLabel}: distribute ${formatAmount(input.total)} ${input.assetSymbol} to ${input.payouts.length} ${input.payouts.length === 1 ? 'holder' : 'holders'} by units held on ${input.recordDate}.`,
  );
  const failed = input.checks.filter((c) => !c.passed);
  if (failed.length === 0) {
    lines.push('All deterministic checks passed.');
  } else {
    lines.push(
      `${failed.length} ${failed.length === 1 ? 'check flagged' : 'checks flagged'}: ${failed
        .map((c) => `${c.label} (${c.actual})`)
        .join('; ')}.`,
    );
  }
  return lines.join(' ');
}

function unavailableMemo(reason: string, input: MemoInput): string {
  return `AI review unavailable: ${reason}. Deterministic checks below are complete.\n\n${templateReview(input)}`;
}

function fingerprintsOf(turn: LlmTurn): Fingerprint[] {
  return [
    { label: 'memo.request', sha256: turn.requestFingerprint },
    { label: 'memo.response', sha256: turn.responseFingerprint },
  ];
}

/**
 * Writes the review memo with one model call. The model gets the proposal as data and one tool;
 * what comes back can only be text and non-blocking advisory flags (A5). The deterministic checks
 * are never passed to anything that could change them: `write` returns only the advisory checks,
 * and the caller keeps its own list of deterministic ones.
 */
export class AiMemoWriter implements MemoWriter {
  constructor(private readonly deps: { llm: Llm }) {}

  async write(input: MemoInput): Promise<MemoResult> {
    let turn: LlmTurn;
    try {
      turn = await this.deps.llm.chat({
        purpose: 'memo',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(reviewPayload(input)) },
        ],
        tools: [WRITE_REVIEW_TOOL],
        toolChoice: { name: WRITE_REVIEW_TOOL.name },
      });
    } catch (error) {
      if (error instanceof LlmUnavailableError) {
        return {
          memo: unavailableMemo(error.reason, input),
          memoSource: 'ai-unavailable',
          advisoryChecks: [],
          modelFingerprints: [],
        };
      }
      throw error;
    }

    try {
      const review = parseReview(turn);
      return {
        memo: review.memo,
        memoSource: 'ai',
        advisoryChecks: review.advisoryFlags.map((flag): CheckResult => ({
          code: 'ai_advisory',
          label: flag.label,
          passed: false,
          blocking: false,
          actual: flag.detail,
          limit: 'Advisory only: a person decides',
          source: 'ai',
        })),
        modelFingerprints: fingerprintsOf(turn),
      };
    } catch (error) {
      if (!(error instanceof LlmInvalidOutputError)) throw error;
      return {
        memo: unavailableMemo('the model answered in a form I could not use', input),
        memoSource: 'ai-unavailable',
        advisoryChecks: [],
        modelFingerprints: fingerprintsOf(turn),
      };
    }
  }
}

function parseReview(turn: LlmTurn): z.output<typeof WriteReviewSchema> {
  const call = turn.toolCalls.find((c) => c.name === WRITE_REVIEW_TOOL.name);
  if (!call) throw new LlmInvalidOutputError('The model did not call write_review.');
  let json: unknown;
  try {
    json = JSON.parse(call.arguments);
  } catch {
    throw new LlmInvalidOutputError('The model sent arguments that are not JSON.');
  }
  const parsed = WriteReviewSchema.safeParse(json);
  if (!parsed.success) {
    throw new LlmInvalidOutputError('The model sent a review that does not fit the tool.');
  }
  return parsed.data;
}
