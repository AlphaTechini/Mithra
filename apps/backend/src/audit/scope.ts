import { z } from 'zod';
import { LlmUnavailableError, type Llm, type LlmTool } from '../llm/client';
import type { ScopeItem } from '../ledger/mithra/templates';

/** One record an audit scope could include, built by the caller from the ledger. */
export interface CatalogEntry {
  recordId: string;
  kind: 'decision' | 'outcome';
  cycleId: string;
  cycleLabel: string;
  flagged: boolean;
  /** When the distribution was executed; null for decisions that were never executed. */
  executedAt: string | null;
}

export interface AuditScopeResult {
  items: ScopeItem[];
  /** What is deliberately left out, in plain English. */
  excluded: string;
  /** `ai` when the model proposed it, `rules` when the deterministic fallback did (A11). */
  source: 'ai' | 'rules';
}

export const DEFAULT_EXCLUDED =
  'Holder identities are shown as Holder A to D unless you ask for them';

const ProposeScopeSchema = z.object({
  items: z
    .array(
      z.object({
        recordId: z.string().min(1),
        reason: z.string().trim().max(300).default(''),
      }),
    )
    .max(200),
  excluded: z.string().trim().max(500).default(''),
});

const PROPOSE_SCOPE_TOOL: LlmTool = {
  name: 'propose_scope',
  description:
    'Propose the smallest set of records that answers the auditor. Use only record ids from the catalog. ' +
    'This only proposes a scope; the treasurer decides whether to share anything.',
  parameters: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            recordId: {
              type: 'string',
              description: 'A record id exactly as listed in the catalog.',
            },
            reason: {
              type: 'string',
              description: 'One line: why this record answers the question.',
            },
          },
          required: ['recordId', 'reason'],
          additionalProperties: false,
        },
      },
      excluded: {
        type: 'string',
        description:
          'One sentence on what is deliberately left out, for example holder identities.',
      },
    },
    required: ['items', 'excluded'],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = [
  'You help an external auditor ask a treasury for records. You turn their question into a scope: a list of record ids, each with a one-line reason.',
  'Rules:',
  '- Choose the smallest set of records that answers the question. Do not add records "just in case".',
  '- Use only record ids that appear in the catalog. Never invent an id.',
  '- A decision record explains how a distribution was prepared (inputs, checks, memo, approvals needed). An outcome record shows what happened (approvals given, payments).',
  '- Holder identities are not part of the catalog; say in `excluded` that they are shown as Holder A to D unless the auditor asks for them.',
  'You only propose. The treasurer decides what is shared. Answer by calling propose_scope.',
].join('\n');

const QUARTER_OF_MONTH = (month: number): number => Math.ceil(month / 3);

const MONTHS: [string, number][] = [
  ['january', 1],
  ['february', 2],
  ['march', 3],
  ['april', 4],
  ['june', 6],
  ['july', 7],
  ['august', 8],
  ['september', 9],
  ['sept', 9],
  ['october', 10],
  ['november', 11],
  ['december', 12],
];

interface Period {
  years: Set<number>;
  quarters: Set<number>;
  months: Set<number>;
}

/** Years, quarters ("Q3") and month names found in the question. */
function periodOf(question: string): Period {
  const years = new Set<number>();
  for (const m of question.matchAll(/\b(20\d{2})\b/g)) years.add(Number(m[1]));
  const quarters = new Set<number>();
  for (const m of question.matchAll(/\bQ([1-4])\b/gi)) quarters.add(Number(m[1]));
  const months = new Set<number>();
  const lower = question.toLowerCase();
  for (const [name, number] of MONTHS) {
    if (new RegExp(`\\b${name}\\b`).test(lower)) months.add(number);
  }
  // "May" is also a verb: only the capitalized word counts.
  if (/\bMay\b/.test(question)) months.add(5);
  return { years, quarters, months };
}

function yearMonthOf(entry: CatalogEntry): { year: number; month: number } | null {
  const fromId = /^(\d{4})-(\d{2})$/.exec(entry.cycleId);
  if (fromId) return { year: Number(fromId[1]), month: Number(fromId[2]) };
  const fromDate = entry.executedAt ? /^(\d{4})-(\d{2})/.exec(entry.executedAt) : null;
  if (fromDate) return { year: Number(fromDate[1]), month: Number(fromDate[2]) };
  return null;
}

function inPeriod(entry: CatalogEntry, period: Period): boolean {
  const none = period.years.size === 0 && period.quarters.size === 0 && period.months.size === 0;
  if (none) return true;
  const ym = yearMonthOf(entry);
  if (!ym) return false;
  if (period.years.size > 0 && !period.years.has(ym.year)) return false;
  if (period.quarters.size === 0 && period.months.size === 0) return true;
  return period.quarters.has(QUARTER_OF_MONTH(ym.month)) || period.months.has(ym.month);
}

function reasonFor(entry: CatalogEntry): string {
  if (entry.kind === 'decision') {
    return entry.flagged
      ? `Decision record for ${entry.cycleLabel}: inputs, checks and the flags that required approval`
      : `Decision record for ${entry.cycleLabel}: inputs, checks and memo`;
  }
  return entry.flagged
    ? `Outcome for ${entry.cycleLabel}: payments and the approvals behind the flagged distribution`
    : `Outcome for ${entry.cycleLabel}: what was paid`;
}

function byCycleThenKind(a: CatalogEntry, b: CatalogEntry): number {
  if (a.cycleId !== b.cycleId) return a.cycleId < b.cycleId ? -1 : 1;
  if (a.kind !== b.kind) return a.kind === 'decision' ? -1 : 1;
  return a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0;
}

/**
 * The scope without a model (A11): the period in the question (quarters, month names, years),
 * and "flagged" narrows it to flagged cycles. Without a period or "flagged", everything.
 */
export function rulesScope(question: string, catalog: readonly CatalogEntry[]): AuditScopeResult {
  const period = periodOf(question);
  const inRange = catalog.filter((e) => inPeriod(e, period));
  const wantsFlagged = /\bflag(?:s|ged)?\b/i.test(question);
  const wantsAll = /\b(?:all|every|each)\b/i.test(question);

  let chosen: CatalogEntry[];
  if (!wantsFlagged) {
    chosen = inRange;
  } else {
    const flaggedCycles = new Set(inRange.filter((e) => e.flagged).map((e) => e.cycleId));
    chosen = wantsAll
      ? // "all distributions and the approvals behind any flagged one": every outcome, plus the decision records of flagged cycles
        inRange.filter((e) => e.kind === 'outcome' || flaggedCycles.has(e.cycleId))
      : inRange.filter((e) => flaggedCycles.has(e.cycleId));
  }
  const items = [...chosen]
    .sort(byCycleThenKind)
    .map((e): ScopeItem => ({ recordId: e.recordId, kind: e.kind, reason: reasonFor(e) }));
  return { items, excluded: DEFAULT_EXCLUDED, source: 'rules' };
}

function catalogForModel(catalog: readonly CatalogEntry[]): string {
  return catalog
    .map(
      (e) =>
        `${e.recordId} | ${e.kind} | ${e.cycleLabel} | ${e.flagged ? 'flagged' : 'not flagged'} | ${e.executedAt ?? 'not executed'}`,
    )
    .join('\n');
}

/**
 * Drafts an audit scope: one model call, then code keeps only record ids that exist in the
 * catalog (the model cannot add a record), removes duplicates and takes the kind from the catalog.
 * Without the model, or with an answer that selects nothing real, the rules scope is returned.
 */
export async function draftAuditScope(
  llm: Llm,
  question: string,
  catalog: readonly CatalogEntry[],
): Promise<AuditScopeResult> {
  if (catalog.length === 0) return rulesScope(question, catalog);
  try {
    const turn = await llm.chat({
      purpose: 'audit.scope',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Catalog (record id | kind | cycle | flagged | executed at):\n${catalogForModel(catalog)}\n\nAuditor's question:\n${question}`,
        },
      ],
      tools: [PROPOSE_SCOPE_TOOL],
      toolChoice: { name: PROPOSE_SCOPE_TOOL.name },
    });
    const call = turn.toolCalls.find((c) => c.name === PROPOSE_SCOPE_TOOL.name);
    if (!call) return rulesScope(question, catalog);
    let json: unknown;
    try {
      json = JSON.parse(call.arguments);
    } catch {
      return rulesScope(question, catalog);
    }
    const parsed = ProposeScopeSchema.safeParse(json);
    if (!parsed.success) return rulesScope(question, catalog);

    const known = new Map(catalog.map((e) => [e.recordId, e]));
    const seen = new Set<string>();
    const items: ScopeItem[] = [];
    for (const proposed of parsed.data.items) {
      const entry = known.get(proposed.recordId);
      if (!entry || seen.has(entry.recordId)) continue;
      seen.add(entry.recordId);
      items.push({
        recordId: entry.recordId,
        kind: entry.kind,
        reason: proposed.reason !== '' ? proposed.reason : reasonFor(entry),
      });
    }
    // An answer of "nothing fits" is honored; an answer made only of invented ids is not trusted.
    if (items.length === 0 && parsed.data.items.length > 0) return rulesScope(question, catalog);
    return {
      items,
      excluded: parsed.data.excluded !== '' ? parsed.data.excluded : DEFAULT_EXCLUDED,
      source: 'ai',
    };
  } catch (error) {
    if (error instanceof LlmUnavailableError) return rulesScope(question, catalog);
    throw error;
  }
}

/** The scope drafter the routes and the agent share; `catalog` is read from the ledger per request. */
export interface ScopeDrafter {
  draft(question: string): Promise<AuditScopeResult>;
}

export function createScopeDrafter(deps: {
  llm: Llm;
  catalog: () => Promise<CatalogEntry[]>;
}): ScopeDrafter {
  return {
    async draft(question) {
      return draftAuditScope(deps.llm, question, await deps.catalog());
    },
  };
}
