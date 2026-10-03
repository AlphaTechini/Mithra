import { z } from 'zod';
import { formatAmount } from '../format';
import { messageOf } from './errors';
import { card, defineTool, failedRun } from './types';

export const getBalanceTool = defineTool({
  name: 'get_balance',
  description: 'Read the treasury balance in CC. Read-only.',
  parameters: z.strictObject({}),
  roles: ['treasurer', 'approver'],
  async run(_args, ctx) {
    const [balance, mandate] = await Promise.all([
      ctx.services.org.balance(),
      ctx.services.org.mandate(),
    ]);
    const symbol = mandate?.terms.assetSymbol ?? 'CC';
    if (balance === null) {
      return failedRun(
        'get_balance',
        'The balance is not available',
        'The token registry did not answer, so I cannot read the balance. Try again in a moment.',
      );
    }
    return {
      card: card({
        tool: 'get_balance',
        title: `Treasury balance: ${formatAmount(balance)} ${symbol}`,
        status: 'done',
        link: '/app',
      }),
      result: { ok: true, balance: `${formatAmount(balance)} ${symbol}` },
    };
  },
});

export const draftAuditScopeTool = defineTool({
  name: 'draft_audit_scope',
  description:
    'Turn an audit question into the smallest list of ledger records that answers it, each with a one-line reason. ' +
    'It only proposes a scope for the treasurer to inspect. It does NOT grant access to anyone; only the treasurer can grant access.',
  parameters: z.strictObject({
    question: z.string().trim().min(1).max(1000).describe('The audit question in plain English.'),
  }),
  roles: ['treasurer'],
  async run(args, ctx) {
    if (!ctx.scope) {
      return failedRun(
        'draft_audit_scope',
        'Could not draft a scope',
        'Audit scoping is not available right now. Use the Audit screen.',
      );
    }
    try {
      const scope = await ctx.scope.draft(args.question);
      return {
        card: card({
          tool: 'draft_audit_scope',
          title: `Drafted an audit scope: ${scope.items.length} ${scope.items.length === 1 ? 'record' : 'records'}`,
          status: 'done',
          summary: scope.excluded,
          details: scope.items.slice(0, 10).map((i) => ({ label: i.recordId, value: i.reason })),
          link: '/app/audit',
        }),
        result: { ok: true, source: scope.source, items: scope.items, excluded: scope.excluded },
      };
    } catch (error) {
      return failedRun('draft_audit_scope', 'Could not draft a scope', messageOf(error));
    }
  },
});

export const closeExpiredGrantsTool = defineTool({
  name: 'close_expired_grants',
  description:
    'Close audit access whose expiry time has passed, now instead of waiting for the automatic check. ' +
    'It only closes access that is already expired. It cannot grant, extend or revoke access.',
  parameters: z.strictObject({}),
  roles: ['treasurer'],
  async run(_args, ctx) {
    if (!ctx.expiry) {
      return failedRun(
        'close_expired_grants',
        'Could not check grants',
        'The expiry job is not running. Expired grants are closed automatically within 5 minutes once it is.',
      );
    }
    try {
      const { closed, failed } = await ctx.expiry.closeExpiredNow();
      return {
        card: card({
          tool: 'close_expired_grants',
          title:
            closed === 0
              ? 'No expired grants to close'
              : `Closed ${closed} expired ${closed === 1 ? 'grant' : 'grants'}`,
          status: failed > 0 ? 'failed' : 'done',
          summary:
            failed > 0
              ? `${failed} could not be closed. They will be retried automatically.`
              : null,
          link: '/app/audit',
        }),
        result: { ok: failed === 0, closed, failed },
      };
    } catch (error) {
      return failedRun('close_expired_grants', 'Could not close expired grants', messageOf(error));
    }
  },
});
