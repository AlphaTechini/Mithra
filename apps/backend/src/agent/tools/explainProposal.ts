import { z } from 'zod';
import { cycleFacts } from './cycleWait';
import { card, defineTool, failedRun } from './types';

export const explainProposalTool = defineTool({
  name: 'explain_proposal',
  description:
    'Look up one cycle and its proposal (checks with actual values, memo, verdict reasons, payouts, approvals) so you can explain it. ' +
    'Give the cycle id (YYYY-MM) or its name ("September 2026"); leave it out for the latest cycle. Read-only: it changes nothing and cannot approve, reject or pay anything.',
  parameters: z.strictObject({
    cycle: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .optional()
      .describe('Cycle id like "2026-09" or a name like "September 2026". Omit for the latest.'),
  }),
  roles: ['treasurer', 'approver'],
  async run(args, ctx) {
    const cycles = await ctx.services.cycles.listCycles();
    const newestFirst = [...cycles].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const wanted = args.cycle?.toLowerCase();
    const summary =
      wanted === undefined
        ? newestFirst[0]
        : newestFirst.find(
            (c) => c.cycleId.toLowerCase() === wanted || c.label.toLowerCase() === wanted,
          );
    if (!summary) {
      return failedRun(
        'explain_proposal',
        'No cycle to explain',
        wanted === undefined
          ? 'There are no cycles yet. Ask me to distribute an amount, or use Run cycle now.'
          : `I could not find a cycle called "${args.cycle}". Check the Cycles screen for the name.`,
      );
    }
    const detail = await ctx.services.cycles.getCycle(summary.cycleId);
    if (!detail) {
      return failedRun(
        'explain_proposal',
        'No cycle to explain',
        'That cycle could not be loaded. Try again in a moment.',
      );
    }
    const mandate = await ctx.services.org.mandate();
    return {
      card: card({
        tool: 'explain_proposal',
        title: `Explained ${detail.summary.label}`,
        status: 'done',
        summary: null,
        link: `/app/cycles/${detail.summary.cycleId}`,
      }),
      result: { ok: true, ...cycleFacts(detail, mandate?.terms.assetSymbol ?? 'CC') },
    };
  },
});
