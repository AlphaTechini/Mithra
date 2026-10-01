import { randomUUID } from 'node:crypto';
import type { ActionCardView, PartyRef, Role } from '@mithra/shared';
import { z } from 'zod';
import type { Fingerprint } from '../../ledger/mithra/templates';
import type { PartyNames } from '../../parties/names';
import type { AgentServices } from '../services';
import type { AuditScopeResult } from '../../audit/scope';

/** What a tool may use besides its arguments. Built by the agent for every call. */
export interface ToolContext {
  /** The signed-in party the agent acts for. */
  partyId: string;
  roles: readonly Role[];
  /** The user's message that started this turn, verbatim. */
  userText: string;
  services: AgentServices;
  names: Pick<PartyNames, 'name'>;
  /** Fingerprints of this turn's model request and response (A12). */
  fingerprints: Fingerprint[];
  /** The expiry job; absent when it is not running. */
  expiry: { closeExpiredNow(): Promise<{ closed: number; failed: number }> } | undefined;
  /** The audit scope drafter; absent when it is not wired. */
  scope: { draft(question: string): Promise<AuditScopeResult> } | undefined;
  /** How long `create_cycle` waits for the proposal. Default 15 s. */
  proposalWaitMs: number;
  /** Pause between polls for the proposal. Default 250 ms. */
  pollMs: number;
  now: () => Date;
}

export interface ToolRun {
  card: ActionCardView;
  /** Goes back to the model as the tool message. Never contains more than the viewer may see. */
  result: unknown;
  /** Sentences written by code that the agent appends to its reply, whatever the model wrote. */
  replyNotes?: string[];
}

/** The card text shown when the model's arguments do not fit the tool (nothing was run). */
export const MALFORMED_REQUEST = "The agent's request was malformed, so nothing was done.";

export interface AgentTool {
  readonly name: string;
  /** Written for the model: what the tool does and what it will not do. */
  readonly description: string;
  readonly parameters: z.ZodObject;
  /** Roles that may use it. The agent offers it, and runs it, only for these. */
  readonly roles: readonly Role[];
  /** Parses and validates the model's JSON arguments, then runs. Never runs on invalid input. */
  execute(rawArguments: string, ctx: ToolContext): Promise<ToolRun>;
}

export interface ToolDefinition<S extends z.ZodObject> {
  name: string;
  description: string;
  parameters: S;
  roles: readonly Role[];
  run(args: z.output<S>, ctx: ToolContext): Promise<ToolRun>;
}

export function newCardId(): string {
  return randomUUID();
}

export function card(input: {
  tool: string;
  title: string;
  status: ActionCardView['status'];
  summary?: string | null;
  details?: { label: string; value: string }[];
  link?: string | null;
}): ActionCardView {
  return {
    id: newCardId(),
    tool: input.tool,
    title: input.title,
    status: input.status,
    summary: input.summary ?? null,
    details: input.details ?? [],
    link: input.link ?? null,
  };
}

/** A failed run: the card says what happened and what to do; the model gets the same text. */
export function failedRun(tool: string, title: string, message: string): ToolRun {
  return {
    card: card({ tool, title, status: 'failed', summary: message }),
    result: { ok: false, error: message },
  };
}

/** Parse the model's argument text. Null values for optional fields count as "not given". */
export function parseArguments<S extends z.ZodObject>(
  schema: S,
  rawArguments: string,
): { ok: true; data: z.output<S> } | { ok: false; reason: string } {
  let json: unknown;
  try {
    json = JSON.parse(rawArguments === '' ? '{}' : rawArguments);
  } catch {
    return { ok: false, reason: 'the arguments are not valid JSON' };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { ok: false, reason: 'the arguments are not a JSON object' };
  }
  // Strict tool schemas make models send null for "not given"; keep null only where the field accepts it.
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(json)) {
    if (value === null) {
      const shape: Record<string, z.ZodType | undefined> = schema.shape;
      const field = shape[key];
      if (field === undefined || !field.safeParse(null).success) continue;
    }
    input[key] = value;
  }
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  const issue = result.error.issues[0];
  const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return { ok: false, reason: `${where}${issue?.message ?? 'invalid arguments'}` };
}

export function defineTool<S extends z.ZodObject>(definition: ToolDefinition<S>): AgentTool {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    roles: definition.roles,
    async execute(rawArguments, ctx) {
      const parsed = parseArguments(definition.parameters, rawArguments);
      if (!parsed.ok) {
        return {
          card: card({
            tool: definition.name,
            title: MALFORMED_REQUEST,
            status: 'failed',
            summary: null,
          }),
          result: { ok: false, error: `${MALFORMED_REQUEST} (${parsed.reason}).` },
        };
      }
      return definition.run(parsed.data, ctx);
    },
  };
}

/** The result of looking a person up by the name the user used. */
export type NameMatch =
  { ok: true; party: PartyRef } | { ok: false; reason: 'unknown' | 'ambiguous' };

/** Case-insensitive exact match first, then a unique partial match ("Holder B" in "Holder B Ltd"). */
export function matchName(name: string, parties: readonly PartyRef[]): NameMatch {
  const wanted = name.trim().toLowerCase();
  const unique = new Map(parties.map((p) => [p.partyId, p]));
  const all = [...unique.values()];
  const exact = all.filter((p) => p.displayName.trim().toLowerCase() === wanted);
  if (exact.length === 1 && exact[0]) return { ok: true, party: exact[0] };
  if (exact.length > 1) return { ok: false, reason: 'ambiguous' };
  const partial = all.filter((p) => p.displayName.toLowerCase().includes(wanted));
  if (partial.length === 1 && partial[0]) return { ok: true, party: partial[0] };
  return { ok: false, reason: partial.length > 1 ? 'ambiguous' : 'unknown' };
}

/** Everyone the agent may name: demo or invited parties plus current holders. */
export async function knownParties(services: AgentServices): Promise<PartyRef[]> {
  const [parties, holders] = await Promise.all([
    services.org.parties(),
    services.org.holders().catch(() => ({ holders: [] })),
  ]);
  return [...parties, ...holders.holders.map((h) => h.holder)];
}

export function nameProblem(name: string, reason: 'unknown' | 'ambiguous'): string {
  return reason === 'unknown'
    ? `I don't know anyone called "${name}". Check the name on the Holders screen and ask again.`
    : `More than one person matches "${name}". Use the full name from the Holders screen.`;
}
