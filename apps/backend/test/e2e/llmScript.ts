import type { StubRequest, StubScript, StubStep } from '../llm-stub/server';

/**
 * The stub model's answers for the demo prompts, so the happy path runs end to end without a
 * language model: the policy draft, "Distribute 300 CC for September", the memo reviews (one
 * advisory flag on a flagged cycle) and the audit scope. It reads what it is shown, like a model
 * would, and answers by calling the same tools. Test code only.
 */

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

function forcedTool(request: StubRequest): string | null {
  const choice = request.tool_choice;
  if (typeof choice === 'object' && choice !== null && 'function' in choice) {
    const fn = (choice as { function?: { name?: unknown } }).function;
    return typeof fn?.name === 'string' ? fn.name : null;
  }
  return null;
}

function lastOf(request: StubRequest, role: string): string {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const message = request.messages[i];
    if (message?.role === role && typeof message.content === 'string') return message.content;
  }
  return '';
}

function amountIn(text: string, pattern: RegExp): string | null {
  const match = pattern.exec(text);
  return match?.[1] ? match[1].replace(/,/g, '') : null;
}

/** The policy the demo prompt describes; what it does not say is left to the defaults in code. */
function policyDraft(prompt: string): StubStep {
  const cap = amountIn(prompt, /under\s+([\d,]+(?:\.\d+)?)\s*CC/i) ?? '5000';
  const threshold = /(\d+)\s+of\s+\d+/i.exec(prompt)?.[1];
  const args: Record<string, unknown> = {
    cap,
    approvalThreshold: threshold ? Number(threshold) : 2,
    scheduleCron: '0 9 1 * *',
  };
  const change = /(\d+)%/.exec(prompt);
  if (change?.[1] && /unit/i.test(prompt)) args['unitChangePct'] = change[1];
  return { toolCalls: [{ name: 'draft_policy', arguments: args }] };
}

interface ReviewPayload {
  cycle: string;
  total: string;
  recordDate: string;
  payouts: { holder: string; units: number; share: string; amount: string }[];
  checks: { check: string; result: string; actual: string }[];
  previousCycles: { cycle: string; total: string }[];
  unitChanges: { holder: string; from: number; to: number }[];
  mandate: { verdict: string; reasons: string[] };
}

/** The memo review: a plain memo from the facts shown, and one advisory flag when something is flagged. */
function memoReview(userContent: string): StubStep {
  let data: ReviewPayload;
  try {
    data = JSON.parse(userContent) as ReviewPayload;
  } catch {
    return {
      toolCalls: [{ name: 'write_review', arguments: { memo: 'Reviewed.', advisoryFlags: [] } }],
    };
  }
  const flagged = data.checks.filter((c) => c.result !== 'passed');
  const lines = [
    `${data.cycle}: ${data.total} to ${data.payouts.length} holders by units held on ${data.recordDate}.`,
    flagged.length === 0
      ? 'All checks passed, nothing looks unusual.'
      : `${flagged.length} checks flagged: ${flagged.map((c) => `${c.check} (${c.actual})`).join('; ')}.`,
  ];
  if (data.unitChanges.length > 0) {
    lines.push(
      `Unit changes shortly before the record date: ${data.unitChanges
        .map((u) => `${u.holder} ${u.from} to ${u.to} units`)
        .join(', ')}.`,
    );
  }
  const advisoryFlags: { label: string; detail: string }[] = [];
  if (flagged.length > 0) {
    const change = data.unitChanges[0];
    advisoryFlags.push({
      label: change
        ? `${change.holder} changed units right before the record date`
        : 'Unusual total',
      detail: change
        ? `${change.holder} went from ${change.from} to ${change.to} units just before the record date while the total is ${data.total}. Worth confirming it is intended.`
        : `The total is ${data.total}, far from the previous cycles.`,
    });
  }
  return {
    toolCalls: [{ name: 'write_review', arguments: { memo: lines.join(' '), advisoryFlags } }],
  };
}

/** Every record of the catalog in the question, for the auditor's "show me everything" scope. */
function auditScope(userContent: string): StubStep {
  const ids: string[] = [];
  for (const line of userContent.split('\n')) {
    const parts = line.split(' | ');
    const id = parts[0]?.trim();
    if (parts.length === 5 && id && /^[A-Za-z0-9:_./-]+$/.test(id)) ids.push(id);
  }
  return {
    toolCalls: [
      {
        name: 'propose_scope',
        arguments: {
          items: ids.map((recordId) => ({ recordId, reason: 'Answers the auditor question' })),
          excluded: 'Holder identities are shown as Holder A to D unless you ask for them',
        },
      },
    ],
  };
}

/** The period of "for September": that month of this year, or last year when it has not come yet. */
function periodOf(monthName: string, now: Date): string | null {
  const index = MONTHS.indexOf(monthName.toLowerCase());
  if (index < 0) return null;
  const year = index > now.getUTCMonth() ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  return `${year}-${String(index + 1).padStart(2, '0')}`;
}

function agentChat(request: StubRequest, now: Date): StubStep {
  const last = request.messages[request.messages.length - 1];
  if (last?.role === 'tool') {
    // After a tool ran: report what it returned, quoting only what the result says.
    let result: {
      proposal?: { total?: string; verdict?: string };
      label?: string;
      status?: string;
      ok?: boolean;
      error?: string;
    };
    try {
      result = JSON.parse(last.content ?? '{}') as typeof result;
    } catch {
      return { text: 'Done.' };
    }
    if (result.ok === false)
      return { text: `That did not work: ${result.error ?? 'see the card'}.` };
    if (result.proposal?.total) {
      return {
        text: `I prepared the proposal for ${result.label ?? 'the cycle'}: ${result.proposal.total}. It is ${result.proposal.verdict === 'needs-approval' ? 'waiting for approvals' : 'within your mandate and runs after the countdown'}.`,
      };
    }
    return { text: 'Done.' };
  }
  const text = lastOf(request, 'user');
  const distribute = /distribute\s+([\d,]+(?:\.\d+)?)\s*(?:CC)?(?:\s+for\s+([A-Za-z]+))?/i.exec(
    text,
  );
  if (distribute?.[1]) {
    const period = distribute[2] ? periodOf(distribute[2], now) : null;
    return {
      toolCalls: [
        {
          name: 'create_cycle',
          arguments: { total: distribute[1].replace(/,/g, ''), ...(period ? { period } : {}) },
        },
      ],
    };
  }
  if (/balance/i.test(text)) return { toolCalls: [{ name: 'get_balance', arguments: {} }] };
  if (/holders/i.test(text)) return { toolCalls: [{ name: 'list_holders', arguments: {} }] };
  return {
    text: 'I can prepare a distribution, draft a policy or look up payments. What would you like?',
  };
}

/** The script for `LlmStub.always`: picks the answer from what the request asks for. */
export function demoLlmScript(now: () => Date = () => new Date()): StubScript {
  return (request): StubStep => {
    switch (forcedTool(request)) {
      case 'draft_policy':
        return policyDraft(lastOf(request, 'user'));
      case 'write_review':
        return memoReview(lastOf(request, 'user'));
      case 'propose_scope':
        return auditScope(lastOf(request, 'user'));
      default:
        return agentChat(request, now());
    }
  };
}
