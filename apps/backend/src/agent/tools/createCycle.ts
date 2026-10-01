import { DecimalString, toDecimal } from '@mithra/shared';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { formatAmount } from '../format';
import { messageOf } from './errors';
import { cycleFacts, isAboveCap, waitForProposal } from './cycleWait';
import { card, defineTool, failedRun, type ToolContext, type ToolRun } from './types';

/**
 * Amounts a person wrote in `text`: "1,200", "1200.50", "5k", "2 million". The agent only starts
 * a cycle for a total that appears in the user's own message, so the model cannot choose one.
 */
export function amountsWritten(text: string): Decimal[] {
  const found: Decimal[] = [];
  const pattern = /(\d{1,3}(?:[,_]\d{3})+|\d+)(\.\d+)?(?:\s*(k|m|thousand|million)\b)?/gi;
  for (const match of text.matchAll(pattern)) {
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
    'The total the treasurer asked to distribute, in CC, exactly as they wrote it, e.g. "1200". Never calculate or round this.',
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

/** Shared by `create_cycle` and `run_cycle_now`: waits for the proposal and builds the card. */
export async function cycleRunOutcome(
  tool: string,
  cycleId: string,
  ctx: ToolContext,
  startedTitle: string,
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
  if (!detail.proposal) {
    const failed = detail.error !== null || detail.summary.status === 'failed';
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
  const payees = p.payouts.length;
  const needsApproval = p.verdict === 'needs-approval';
  const cap = detail.decisionRecord?.cap ?? mandate?.terms.cap ?? null;
  const aboveCap = needsApproval && cap !== null && isAboveCap(p.total, cap);
  const failedChecks = p.checks.filter((c) => !c.passed);
  const replyNotes: string[] = [];
  if (aboveCap && cap !== null) {
    replyNotes.push(
      `${formatAmount(p.total)} ${symbol} is above your auto-pay cap of ${formatAmount(cap)} ${symbol}. I've prepared this as a proposal that needs ${p.approvalThreshold} of ${p.approvers.length} approvals.`,
    );
  }
  return {
    card: card({
      tool,
      title: `Created proposal for ${detail.summary.label}, ${payees} ${payees === 1 ? 'payee' : 'payees'}, ${formatAmount(p.total)} ${symbol}`,
      status: needsApproval ? 'needs-you' : 'done',
      summary: needsApproval
        ? `Needs ${p.approvalThreshold} of ${p.approvers.length} approvals. ${p.verdictReasons.join(' ')}`.trim()
        : 'Within your mandate. It runs automatically after the hold countdown.',
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
      ok: true,
      proposalReady: true,
      note: 'The proposal was prepared by code. Nothing was paid. Quote amounts exactly as given here.',
      ...cycleFacts(detail, symbol),
    },
    replyNotes,
  };
}

export const createCycleTool = defineTool({
  name: 'create_cycle',
  description:
    'Prepare a distribution proposal for a cycle from the total the treasurer asked for in their message ' +
    '("Distribute 1,200 CC for September"). Pass the total exactly as the treasurer wrote it and the month if they named one. ' +
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
    );
  },
});
