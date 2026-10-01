import { z } from 'zod';
import { formatAmount } from '../format';
import { messageOf } from './errors';
import { card, defineTool, failedRun, matchName, nameProblem } from './types';

export const listHoldersTool = defineTool({
  name: 'list_holders',
  description:
    "List the fund's holders with their units, share of all units, auto-receive status and last payment. Read-only.",
  parameters: z.strictObject({}),
  roles: ['treasurer', 'approver'],
  async run(_args, ctx) {
    const response = await ctx.services.org.holders();
    const rows = response.holders;
    return {
      card: card({
        tool: 'list_holders',
        title: `Listed ${rows.length} ${rows.length === 1 ? 'holder' : 'holders'}`,
        status: 'done',
        summary: `${response.totalUnits} units in total`,
        details: rows.slice(0, 8).map((r) => ({
          label: r.holder.displayName,
          value: `${r.units} units (${r.sharePct}%)`,
        })),
        link: '/app/holders',
      }),
      result: {
        ok: true,
        totalUnits: response.totalUnits,
        holders: rows.map((r) => ({
          name: r.holder.displayName,
          units: r.units,
          sharePct: r.sharePct,
          autoReceive: r.autoReceive,
          unitsAccepted: r.unitsAccepted,
          lastPayment: r.lastPayment
            ? {
                amount: formatAmount(r.lastPayment.amount),
                at: r.lastPayment.at,
                cycle: r.lastPayment.cycleLabel,
              }
            : null,
        })),
      },
    };
  },
});

export const issueUnitsTool = defineTool({
  name: 'issue_units',
  description:
    'Issue fund units to a holder by name (a whole number of units). The units count for payouts once the holder accepts them and the record date has passed. ' +
    'It does NOT pay anyone and cannot remove units.',
  parameters: z.strictObject({
    holderName: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .describe('The holder\'s name as shown in the app, e.g. "Holder B".'),
    units: z.number().int().positive().max(1_000_000_000).describe('Number of units to issue.'),
  }),
  roles: ['treasurer'],
  async run(args, ctx) {
    const match = matchName(args.holderName, await ctx.services.org.parties());
    if (!match.ok) {
      return failedRun(
        'issue_units',
        'Could not issue units',
        nameProblem(args.holderName, match.reason),
      );
    }
    try {
      await ctx.services.org.issueUnits({
        holder: match.party.partyId,
        units: args.units,
        actorParty: ctx.partyId,
      });
    } catch (error) {
      return failedRun('issue_units', 'Could not issue units', messageOf(error));
    }
    return {
      card: card({
        tool: 'issue_units',
        title: `Issued ${args.units} units to ${match.party.displayName}`,
        status: 'done',
        summary: `${match.party.displayName} needs to accept the units before they count.`,
        link: '/app/holders',
      }),
      result: { ok: true, holder: match.party.displayName, units: args.units },
    };
  },
});

export const inviteHolderTool = defineTool({
  name: 'invite_holder',
  description:
    'Create an invitation link for a new holder, with the name the treasurer gives. It only creates the link; it does not issue units or pay anything.',
  parameters: z.strictObject({
    displayName: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .describe('The name of the person or company being invited.'),
  }),
  roles: ['treasurer'],
  async run(args, ctx) {
    try {
      const invite = await ctx.services.org.createInvite({
        kind: 'holder',
        displayName: args.displayName,
        actorParty: ctx.partyId,
      });
      return {
        card: card({
          tool: 'invite_holder',
          title: `Invited ${invite.displayName} as a holder`,
          status: 'done',
          summary: `Send them this link: ${invite.path}`,
          details: [{ label: 'Invite link', value: invite.path }],
          link: invite.path,
        }),
        result: { ok: true, displayName: invite.displayName, path: invite.path },
      };
    } catch (error) {
      return failedRun('invite_holder', 'Could not create the invitation', messageOf(error));
    }
  },
});
