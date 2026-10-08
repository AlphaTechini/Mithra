import {
  DecimalString,
  toDecimal,
  type ActionCardView,
  type CycleDetail,
  type CycleStatus,
} from '@mithra/shared';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { formatAmount, longDateOf, plural } from '../format';
import { messageOf } from './errors';
import { cycleFacts, isAboveCap, waitForProposal } from './cycleWait';
import { card, defineTool, failedRun, type ToolContext, type ToolRun } from './types';

const MONTH =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

/**
 * Numbers that are dates, periods, counts or ratios rather than amounts: a cycle id or ISO date
 * (2026-09, 2026-09-30), a year or day next to a month name (September 2026, 30 September), a
 * quarter (Q3, Q3 2026), "2 of 3", an ordinal (3rd) and a percentage (50%).
 */
const NOT_AMOUNTS = new RegExp(
  [
    String.raw`(?<![\d,.])\d{4}-\d{2}(?:-\d{2})?(?![\d-])`,
    String.raw`\b${MONTH}\b\.?\s+(?:\d{1,2}(?:st|nd|rd|th)?\b(?:,?\s+\d{4}\b)?|\d{4}\b)`,
    String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH}\b\.?(?:,?\s+\d{4}\b)?`,
    String.raw`\bQ[1-4]\b(?:\s+\d{4}\b)?`,
    String.raw`\b\d+\s+of\s+\d+\b`,
    String.raw`\b\d+(?:st|nd|rd|th)\b`,
    String.raw`\d+(?:\.\d+)?\s*(?:%|percent\b|per\s+cent\b)`,
  ].join('|'),
  'gi',
);

/**
 * Amounts a person wrote in `text`: "1,200", "1200.50", "5k", "2 million". The agent only starts
 * a cycle for a total that appears in the user's own message, so the model cannot choose one.
 * Years, dates, cycle ids, quarters, "2 of 3", ordinals and percentages are not amounts.
 */
export function amountsWritten(text: string): Decimal[] {
  const found: Decimal[] = [];
  const pattern = /(\d{1,3}(?:[,_]\d{3})+|\d+)(\.\d+)?(?:\s*(k|m|thousand|million)\b)?/gi;
  for (const match of text.replace(NOT_AMOUNTS, ' ').matchAll(pattern)) {
    const whole = (match[1] ?? '').replace(/[,_]/g, '');
    const value = new Decimal(`${whole}${match[2] ?? ''}`);
    const suffix = (match[3] ?? '').toLowerCase();
    const factor =
      suffix === 'k' || suffix === 'thousand'
        ? 1_000
        : suffix === 'm' || suffix === 'million'
          ? 1_000_000
          : 1;
    found.push(value.mul(factor));
  }
  return found;
}

export function triggerDetailFor(name: string, text: string): string {
  const quoted = text.length > 200 ? `${text.slice(0, 200)}...` : text;
  return `Prompt from ${name}: "${quoted}"`;
}

const PositiveAmount = DecimalString.refine(
  (s) => DecimalString.safeParse(s).success && toDecimal(s).gt(0),
  'must be more than 0',
);

export const createCycleParameters = z.strictObject({
  total: PositiveAmount.describe(
    'The total the treasurer asked to distribute, in CC, as plain digits without thousands separators: they wrote "1,200", pass "1200". Never calculate or round this.',
  ),
  period: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must look like 2026-09')
    .optional()
    .describe('The month being paid, as YYYY-MM, if the treasurer named one.'),
  recordDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'must look like 2026-09-30')
    .optional()
    .describe('The record date, as YYYY-MM-DD, only if the treasurer named one.'),
});

const RERUNNABLE: readonly CycleStatus[] = ['failed', 'rejected', 'cancelled'];

/**
 * The cycles that exist before a run, by id. `run` answers with the id of an existing cycle and
 * creates nothing when that cycle is open or paid, so the tools need this to word what happened.
 */
export async function cycleStatusesBefore(ctx: ToolContext): Promise<Map<string, CycleStatus>> {
  try {
    const list = await ctx.services.cycles.listCycles();
    return new Map(list.map((c) => [c.cycleId, c.status]));
  } catch {
    return new Map();
  }
}

interface Worded {
  title: string;
  status: ActionCardView['status'];
  summary: string;
}

/**
 * The card and reply text for a cycle, from the status it has now (never from what the tool
 * expected to happen). `existed`: the cycle was already there, so nothing new was created.
 */
function wordCycle(
  detail: CycleDetail,
  symbol: string,
  existed: boolean,
  fallbackTitle: string,
): Worded {
  const { label, status } = detail.summary;
  const tail = existed ? ' Nothing new was created.' : '';
  const p = detail.proposal;
  const paidOn = detail.outcome?.kind === 'executed' ? ` on ${longDateOf(detail.outcome.at)}` : '';
  const created = (): string => {
    const payees = p?.payouts.length ?? 0;
    return `Created proposal for ${label}, ${payees} ${payees === 1 ? 'payee' : 'payees'}, ${formatAmount(p?.total ?? detail.summary.total ?? '0')} ${symbol}`;
  };

  switch (status) {
    case 'paid-automatically':
    case 'paid-after-approval':
    case 'awaiting-acceptance': {
      const how = status === 'paid-after-approval' ? 'after approval' : 'automatically';
      const text =
        status === 'awaiting-acceptance'
          ? `${label} was already paid${paidOn}; at least one holder still has to accept their payment.`
          : `${label} was already paid ${how}${paidOn}.`;
      return existed
        ? { title: `${label} was already paid`, status: 'done', summary: `${text}${tail}` }
        : {
            title: `${label} was paid`,
            status: 'done',
            summary: text.replace('was already paid', 'was paid'),
          };
    }
    case 'awaiting-signature':
      return {
        title: existed ? `${label} is waiting for your signatures in Grofty` : created(),
        status: 'needs-you',
        summary: `The ledger checked the Mandate rules for ${label}. Open the cycle and sign the payouts in Grofty; nothing is paid until you do.${tail}`,
      };
    case 'needs-wallets': {
      const names = (detail.needsWallets ?? []).map((h) => h.displayName).join(', ');
      return {
        title: existed ? `${label} is waiting for holders to connect Grofty` : created(),
        status: 'needs-you',
        summary: `${label} is ready to pay, but ${names || 'some holders'} must connect Grofty Wallet first.${tail}`,
      };
    }
    case 'executing':
      return {
        title: `${label} is being paid`,
        status: 'done',
        summary: `The payments for ${label} are being made now.${tail}`,
      };
    case 'awaiting-approval': {
      const need = p?.approvalThreshold ?? 0;
      const of = p?.approvers.length ?? 0;
      const have = p?.approvals.length ?? 0;
      const reasons = p?.verdictReasons.join(' ') ?? '';
      return existed
        ? {
            title: `${label} already has a proposal waiting for approval`,
            status: 'needs-you',
            summary:
              `Needs ${need} of ${plural(of, 'approval')}, ${have} so far. ${reasons}${tail}`.replace(
                /\s+/g,
                ' ',
              ),
          }
        : {
            title: created(),
            status: 'needs-you',
            summary: `Needs ${need} of ${plural(of, 'approval')}. ${reasons}`.trim(),
          };
    }
    case 'countdown':
      return existed
        ? {
            title: `${label} already has a proposal within your mandate`,
            status: 'done',
            summary: `It runs automatically after the hold countdown.${tail}`,
          }
        : {
            title: created(),
            status: 'done',
            summary: 'Within your mandate. It runs automatically after the hold countdown.',
          };
    case 'held':
      return {
        title: existed ? `${label} is on hold` : created(),
        status: 'needs-you',
        summary: `The proposal for ${label} is on hold. Release it from the cycle page to let it run.${tail}`,
      };
    case 'needs-funds': {
      const short = detail.fundsShortfall;
      const amounts = short
        ? ` ${formatAmount(short.balance)} ${symbol} available, ${formatAmount(short.required)} ${symbol} needed.`
        : '';
      return {
        title: existed ? `${label} is waiting for funds` : created(),
        status: 'needs-you',
        summary: `The treasury does not have enough funds to pay ${label}.${amounts} Add funds and the payment continues.${tail}`,
      };
    }
    case 'failed':
      return {
        title: `The cycle for ${label} failed`,
        status: 'failed',
        summary: detail.error ?? 'The cycle failed. Open it for the reason.',
      };
    case 'rejected':
    case 'cancelled':
      return {
        title: `The proposal for ${label} was ${status}`,
        status: 'done',
        summary: `The proposal for ${label} was ${status}${detail.outcome?.reason ? `: ${detail.outcome.reason}` : '.'}${tail}`,
      };
    case 'running':
      return {
        title: fallbackTitle,
        status: 'done',
        summary: 'The proposal is still being prepared. Open the cycle to watch the timeline.',
      };
  }
}

/**
 * Shared by `create_cycle` and `run_cycle_now`: waits for the proposal, reads the cycle's actual
 * status and words the card and the reply from it. `before` is `cycleStatusesBefore`, read before
 * `run`, to tell a cycle that already existed (nothing new was created) from a new one.
 */
export async function cycleRunOutcome(
  tool: string,
  cycleId: string,
  ctx: ToolContext,
  startedTitle: string,
  before: ReadonlyMap<string, CycleStatus> = new Map(),
): Promise<ToolRun> {
  const mandate = await ctx.services.org.mandate();
  const symbol = mandate?.terms.assetSymbol ?? 'CC';
  const detail = await waitForProposal(ctx.services, cycleId, {
    timeoutMs: ctx.proposalWaitMs,
    pollMs: ctx.pollMs,
  });
  const link = `/app/cycles/${cycleId}`;

  if (!detail) {
    return {
      card: card({
        tool,
        title: startedTitle,
        status: 'done',
        summary: 'The cycle is still starting. Open it to watch the timeline.',
        link,
      }),
      result: {
        ok: true,
        cycleId,
        proposalReady: false,
        note: 'The proposal is not ready yet. It has not been paid.',
      },
    };
  }
  const previous = before.get(cycleId);
  const existed = previous !== undefined && !RERUNNABLE.includes(previous);
  const failed = detail.error !== null || detail.summary.status === 'failed';
  if (!detail.proposal) {
    return {
      card: card({
        tool,
        title: failed
          ? `The cycle for ${detail.summary.label} did not produce a proposal`
          : startedTitle,
        status: failed ? 'failed' : 'done',
        summary: failed
          ? (detail.error ?? 'The cycle failed. Open it for the reason.')
          : 'The proposal is still being prepared. Open the cycle to watch the timeline.',
        link,
      }),
      result: { ok: !failed, proposalReady: false, ...cycleFacts(detail, symbol) },
    };
  }

  const p = detail.proposal;
  const needsApproval = p.verdict === 'needs-approval';
  const cap = detail.decisionRecord?.cap ?? mandate?.terms.cap ?? null;
  const aboveCap =
    !existed &&
    detail.summary.status === 'awaiting-approval' &&
    cap !== null &&
    isAboveCap(p.total, cap);
  const worded = wordCycle(detail, symbol, existed, startedTitle);
  const failedChecks = p.checks.filter((c) => !c.passed);
  const replyNotes: string[] = [];
  if (aboveCap && cap !== null) {
    replyNotes.push(
      `${formatAmount(p.total)} ${symbol} is above your auto-pay cap of ${formatAmount(cap)} ${symbol}. I've prepared this as a proposal that needs ${p.approvalThreshold} of ${plural(p.approvers.length, 'approval')}.`,
    );
  }
  // What the cycle already was, or how it ended: said in the reply by code, whatever the model wrote.
  if (existed || detail.summary.status === 'failed') replyNotes.push(worded.summary);
  const alreadyPaid = ['paid-automatically', 'paid-after-approval', 'awaiting-acceptance'].includes(
    detail.summary.status,
  );
  return {
    card: card({
      tool,
      title: worded.title,
      status: worded.status,
      summary: worded.summary,
      details: [
        { label: 'Total', value: `${formatAmount(p.total)} ${symbol}` },
        { label: 'Record date', value: p.recordDate },
        { label: 'Verdict', value: needsApproval ? 'Needs approval' : 'Within mandate' },
        {
          label: 'Flags',
          value: failedChecks.length === 0 ? 'None' : failedChecks.map((c) => c.label).join('; '),
        },
      ],
      link,
    }),
    result: {
      ok: !failed,
      proposalReady: true,
      existedBefore: existed,
      note: existed
        ? alreadyPaid
          ? 'This cycle already existed and was already paid. Nothing new was created and nothing more was paid. Say exactly that; quote the date and amounts as given here.'
          : 'This cycle already existed. Nothing new was created. Say where it stands from the status given here; quote amounts exactly.'
        : alreadyPaid
          ? 'The cycle was paid. Quote amounts exactly as given here.'
          : 'The proposal was prepared by code. Nothing was paid yet. Quote amounts and the status exactly as given here.',
      ...cycleFacts(detail, symbol),
    },
    replyNotes,
  };
}

export const createCycleTool = defineTool({
  name: 'create_cycle',
  description:
    'Prepare a distribution proposal for a cycle from the total the treasurer asked for in their message ' +
    '("Distribute 1,200 CC for September"). Pass the total the treasurer wrote, as plain digits ("1,200" becomes "1200"), and the month if they named one. ' +
    'Code splits the total by units on the record date, runs the checks and decides whether it fits the Mandate. ' +
    'It does NOT pay anyone, never takes per-holder amounts, and a total above the cap simply becomes a proposal that needs approvals. ' +
    'Call it once per request.',
  parameters: createCycleParameters,
  roles: ['treasurer'],
  async run(args, ctx) {
    // The model only passes along the number the treasurer wrote; it may not pick another one.
    const requested = toDecimal(args.total);
    if (!amountsWritten(ctx.userText).some((a) => a.equals(requested))) {
      return failedRun(
        'create_cycle',
        "I couldn't match the amount to your message, so nothing was done.",
        `The total ${formatAmount(args.total)} is not an amount you wrote. Tell me the amount in digits, for example "Distribute 1,200 CC for September", or use Run cycle now.`,
      );
    }
    const name = await ctx.names.name(ctx.partyId);
    const before = await cycleStatusesBefore(ctx);
    let started: { cycleId: string };
    try {
      started = await ctx.services.cycles.run({
        trigger: 'prompt',
        triggerDetail: triggerDetailFor(name, ctx.userText),
        ...(args.period ? { cycleId: args.period } : {}),
        total: args.total,
        ...(args.recordDate ? { recordDate: args.recordDate } : {}),
        promptText: ctx.userText,
        modelFingerprints: ctx.fingerprints,
        actorParty: ctx.partyId,
      });
    } catch (error) {
      return failedRun('create_cycle', 'Could not create the proposal', messageOf(error));
    }
    return cycleRunOutcome(
      'create_cycle',
      started.cycleId,
      ctx,
      `Started the cycle ${started.cycleId}`,
      before,
    );
  },
});
