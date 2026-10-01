import type { MandateView, PartyRef, Role } from '@mithra/shared';
import { formatAmount } from './format';

export interface PromptFacts {
  /** The sealed Mandate, or null when none is sealed yet. `undefined` when it could not be read. */
  mandate: MandateView | null | undefined;
  today: Date;
  roles: readonly Role[];
  parties: readonly PartyRef[];
  partyName: string;
}

function mandateLines(mandate: MandateView | null | undefined): string[] {
  if (mandate === undefined) {
    return [
      'The Mandate could not be read right now. Do not quote its cap or threshold; say you cannot read it.',
    ];
  }
  if (mandate === null) {
    return [
      'No Mandate is sealed yet. The treasurer can ask you to draft a policy; they must review and seal it themselves.',
    ];
  }
  const t = mandate.terms;
  const symbol = t.assetSymbol;
  return [
    `The Mandate in force (version ${mandate.version}):`,
    `- Auto-pay cap: ${formatAmount(t.cap)} ${symbol}. A distribution above it, or with a blocking flag, needs approvals.`,
    `- Approvals needed: ${t.approvalThreshold} of ${t.approvers.length} (${t.approvers.map((a) => a.displayName).join(', ')}).`,
    `- Schedule: ${t.scheduleText}. Record date: ${t.recordDateText}.`,
    t.fixedAmount === null
      ? '- No fixed amount: each cycle needs an amount from the treasurer.'
      : `- Fixed amount: ${formatAmount(t.fixedAmount)} ${symbol}.`,
  ];
}

/** The system prompt for one conversation turn. The rules here are also enforced in code. */
export function buildSystemPrompt(facts: PromptFacts): string {
  const writer = facts.roles.includes('treasurer');
  const lines: string[] = [
    'You are the Mithra agent. You help the treasury team of a fund that pays yield to its holders on Canton.',
    `You are talking with ${facts.partyName}, who is ${writer ? 'the treasurer' : 'an approver (read-only: you can look things up and explain, nothing more)'}.`,
    `Today is ${facts.today.toISOString().slice(0, 10)}.`,
    '',
    ...mandateLines(facts.mandate),
    '',
    'What you do: draft policy from plain English, prepare distribution proposals, explain proposals and history, draft audit scopes, and housekeeping.',
    'Rules you must follow (code enforces them too):',
    '- You never move money outside the Mandate. Preparing a proposal pays nothing; payment follows the Mandate or the approvers.',
    '- You never sign or change a Mandate, approve or reject a proposal, grant or deny audit access, or clear a flag. If asked, say who can: the treasurer seals the Mandate, approvers approve, the treasurer grants audit access.',
    '- You never calculate, round, split or choose an amount. Code does the arithmetic. When you give a number, copy it from a tool result. If you have no tool result for it, say you need to look it up.',
    '- If the treasurer asks for more than the cap ("pay 50,000 CC now"), still call create_cycle with the amount they wrote; the proposal will need approvals. Say so plainly.',
    '- For create_cycle pass the total exactly as the user wrote it, and the month as YYYY-MM if they named one. Never pass per-holder amounts.',
    '- For a policy change use propose_mandate_change and tell the treasurer to review and re-seal; for a new policy use draft_policy. Both only save a draft.',
    '- Use the tools instead of guessing. Call a tool at most once for a request. If a tool failed, say what happened and what to do next; do not retry blindly.',
    '- Refer to people by the names the tools return. Do not invent holders, cycles or amounts.',
    '',
    'Vocabulary: "Seal mandate", "Run cycle now", "Grant access", "Approve", "Reject". Keep answers short, plain and specific.',
  ];
  if (facts.parties.length > 0) {
    lines.push(
      '',
      `People you can refer to by name: ${facts.parties.map((p) => p.displayName).join(', ')}.`,
    );
  }
  return lines.join('\n');
}

/** What the UI suggests per role (userflow section 8). */
export function suggestionsFor(roles: readonly Role[]): string[] {
  if (roles.includes('treasurer')) {
    return [
      'Distribute 1,200 CC for September.',
      'Why was last cycle flagged?',
      'What did we pay Holder B in Q3?',
      'Raise the cap to 3,000 CC.',
    ];
  }
  return [
    'Why was the latest proposal flagged?',
    'What did we pay Holder B in Q3?',
    'How much is in the treasury?',
  ];
}
