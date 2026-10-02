import {
  DraftPolicyArgsSchema,
  MandateChangeArgsSchema,
  policyDetails,
  resolveDraftPolicy,
  resolveMandateChange,
} from '../policyFields';
import { messageOf } from './errors';
import { card, defineTool, failedRun } from './types';

export const draftPolicyTool = defineTool({
  name: 'draft_policy',
  description:
    "Turn the treasurer's plain-English description into a draft policy (schedule, cap, approvals, flag thresholds). " +
    'Name approvers by name only if the treasurer did. Fill only what they said; sensible defaults cover the rest. ' +
    'It only saves a DRAFT for the treasurer to review, edit and seal. It does NOT seal the Mandate or change anything on the ledger.',
  parameters: DraftPolicyArgsSchema,
  roles: ['treasurer'],
  async run(args, ctx) {
    const resolved = await resolveDraftPolicy(args, ctx.services, ctx.partyId);
    if (!resolved.ok) {
      return failedRun('draft_policy', 'Could not draft the policy', resolved.message);
    }
    try {
      const draft = await ctx.services.policy.saveDraft(resolved.fields, 'agent', ctx.partyId);
      return {
        card: card({
          tool: 'draft_policy',
          title: 'Drafted a policy for you to review and seal',
          status: 'needs-you',
          summary: draft.summary,
          details: policyDetails(resolved.fields, resolved.approvers),
          link: '/setup/policy',
        }),
        result: {
          ok: true,
          note: 'A draft was saved. It is not in force until the treasurer seals it.',
          summary: draft.summary,
        },
      };
    } catch (error) {
      return failedRun('draft_policy', 'Could not save the draft', messageOf(error));
    }
  },
});

export const proposeMandateChangeTool = defineTool({
  name: 'propose_mandate_change',
  description:
    'Draft a change to the sealed Mandate, for example "raise the cap to 3,000". Pass only the fields that change; everything else stays as sealed. ' +
    'It only saves a DRAFT. The treasurer must review it and re-seal the Mandate to apply it. It does NOT change the Mandate, and it cannot sign anything.',
  parameters: MandateChangeArgsSchema,
  roles: ['treasurer'],
  async run(args, ctx) {
    const resolved = await resolveMandateChange(args, ctx.services);
    if (!resolved.ok) {
      return failedRun(
        'propose_mandate_change',
        'Could not draft the Mandate change',
        resolved.message,
      );
    }
    try {
      const draft = await ctx.services.policy.saveDraft(resolved.fields, 'agent', ctx.partyId);
      return {
        card: card({
          tool: 'propose_mandate_change',
          title: 'Drafted a Mandate change. Review and re-seal to apply it.',
          status: 'needs-you',
          summary: draft.summary,
          details: resolved.changes.map((c) => ({ label: c.label, value: `${c.from} to ${c.to}` })),
          link: '/app/settings',
        }),
        result: {
          ok: true,
          note: 'A draft change was saved. The current Mandate stays in force until the treasurer re-seals.',
          changes: resolved.changes,
        },
      };
    } catch (error) {
      return failedRun('propose_mandate_change', 'Could not save the draft', messageOf(error));
    }
  },
});
