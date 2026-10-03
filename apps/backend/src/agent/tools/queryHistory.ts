import { sumDecimals } from '@mithra/shared';
import { z } from 'zod';
import { formatAmount } from '../format';
import { card, defineTool, failedRun, knownParties, matchName, nameProblem } from './types';

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must look like 2026-07-01');

/** Sums of payment rows, computed with decimal.js. The model quotes these; it never adds. */
export function sumPayments(
  rows: { holder: { partyId: string; displayName: string }; amount: string; status: string }[],
): {
  total: string;
  byHolder: { holder: string; total: string; payments: number }[];
  byStatus: { status: string; total: string; payments: number }[];
} {
  const holders = new Map<string, { name: string; amounts: string[] }>();
  const statuses = new Map<string, string[]>();
  for (const row of rows) {
    const h = holders.get(row.holder.partyId) ?? { name: row.holder.displayName, amounts: [] };
    h.amounts.push(row.amount);
    holders.set(row.holder.partyId, h);
    statuses.set(row.status, [...(statuses.get(row.status) ?? []), row.amount]);
  }
  return {
    total: sumDecimals(rows.map((r) => r.amount)),
    byHolder: [...holders.values()]
      .map((h) => ({ holder: h.name, total: sumDecimals(h.amounts), payments: h.amounts.length }))
      .sort((a, b) => a.holder.localeCompare(b.holder)),
    byStatus: [...statuses.entries()].map(([status, amounts]) => ({
      status,
      total: sumDecimals(amounts),
      payments: amounts.length,
    })),
  };
}

export const queryHistoryTool = defineTool({
  name: 'query_history',
  description:
    'Look up payment history, optionally for one holder (by name) and a date range. Returns the rows and the sums, which code computes. ' +
    'Quote the sums exactly as given and never add or estimate amounts yourself. Read-only. ' +
    'For "Q3" use from 07-01 and to 09-30 of the year the treasurer means.',
  parameters: z.strictObject({
    holderName: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional()
      .describe('The holder\'s name, e.g. "Holder B".'),
    from: IsoDate.optional().describe('First day, YYYY-MM-DD.'),
    to: IsoDate.optional().describe('Last day, YYYY-MM-DD.'),
  }),
  roles: ['treasurer', 'approver'],
  async run(args, ctx) {
    let holder: { partyId: string; displayName: string } | undefined;
    if (args.holderName !== undefined) {
      const match = matchName(args.holderName, await knownParties(ctx.services));
      if (!match.ok) {
        return failedRun(
          'query_history',
          'Could not look up that holder',
          nameProblem(args.holderName, match.reason),
        );
      }
      holder = match.party;
    }
    const rows = await ctx.services.history.payments({
      ...(holder ? { holder: holder.partyId } : {}),
      ...(args.from ? { from: args.from } : {}),
      ...(args.to ? { to: args.to } : {}),
    });
    const sums = sumPayments(rows);
    const mandate = await ctx.services.org.mandate();
    const symbol = mandate?.terms.assetSymbol ?? 'CC';
    const range = [args.from, args.to].filter(Boolean).join(' to ');
    const who = holder ? holder.displayName : 'all holders';
    return {
      card: card({
        tool: 'query_history',
        title: `Looked up payments for ${who}${range ? `, ${range}` : ''}`,
        status: 'done',
        summary: `${rows.length} ${rows.length === 1 ? 'payment' : 'payments'}, ${formatAmount(sums.total)} ${symbol} in total`,
        details: sums.byHolder.map((h) => ({
          label: h.holder,
          value: `${formatAmount(h.total)} ${symbol} in ${h.payments} ${h.payments === 1 ? 'payment' : 'payments'}`,
        })),
        link: '/app/cycles',
      }),
      result: {
        ok: true,
        note: 'The sums were computed by code. Quote them as given.',
        asset: symbol,
        rowCount: rows.length,
        sums: {
          totalReadable: `${formatAmount(sums.total)} ${symbol}`,
          byHolder: sums.byHolder.map((h) => ({
            ...h,
            total: `${formatAmount(h.total)} ${symbol}`,
          })),
          byStatus: sums.byStatus.map((s) => ({
            ...s,
            total: `${formatAmount(s.total)} ${symbol}`,
          })),
        },
        rows: rows.map((r) => ({
          holder: r.holder.displayName,
          cycle: r.cycleLabel,
          amount: `${formatAmount(r.amount)} ${symbol}`,
          at: r.at,
          status: r.status,
        })),
      },
    };
  },
});
