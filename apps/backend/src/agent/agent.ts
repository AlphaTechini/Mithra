import {
  ActionCardViewSchema,
  type ActionCardView,
  type AgentConversation,
  type AgentMessage,
  type MandateView,
  type PartyRef,
  type Role,
  type SendAgentMessageResponse,
} from '@mithra/shared';
import { z } from 'zod';
import type { ActivityLog } from '../activity/log';
import type { Database } from '../db';
import type { EventBus } from '../events/bus';
import { ApiError } from '../http/errors';
import type { Fingerprint } from '../ledger/mithra/templates';
import {
  LlmInvalidOutputError,
  LlmUnavailableError,
  type Llm,
  type LlmMessage,
  type LlmToolCall,
  type LlmTurn,
} from '../llm/client';
import type { PartyNames } from '../parties/names';
import { buildSystemPrompt, suggestionsFor } from './prompt';
import { createAgentStore, type AgentStore, type StoredMessage } from './store';
import type { AgentServices } from './services';
import {
  ALL_TOOLS,
  llmToolOf,
  toolsForRoles,
  type AgentTool,
  type ToolContext,
  type ToolRun,
} from './tools';
import { messageOf } from './tools/errors';
import { card } from './tools/types';

export interface AgentDeps {
  llm: Llm;
  services: AgentServices;
  names: Pick<PartyNames, 'name'>;
  bus: EventBus;
  /** The application database; used for the default store. */
  db?: Database;
  /** Overrides the database store (unit tests). */
  store?: AgentStore;
  activity: Pick<ActivityLog, 'record'>;
  /** The grant expiry job, for `close_expired_grants`. */
  expiry?: ToolContext['expiry'];
  /** The audit scope drafter, for `draft_audit_scope`. */
  scope?: ToolContext['scope'];
  /** Tool-calling rounds per message. Default 4 (`LLM_MAX_TOOL_ROUNDS`). */
  maxToolRounds?: number;
  /** Send `strict: true` on tool definitions (`LLM_STRICT_TOOLS`). */
  strictTools?: boolean;
  /** How long `create_cycle` waits for the proposal. Default 15 s. */
  proposalWaitMs?: number;
  pollMs?: number;
  now?: () => Date;
  log?: { warn(object: unknown, message?: string): void };
}

export interface Agent {
  /** One user message in, one reply out, with the tool calls shown as action cards. */
  respond(input: {
    partyId: string;
    roles: readonly Role[];
    text: string;
  }): Promise<SendAgentMessageResponse>;
  /** The party's conversation and the prompts the UI suggests. */
  conversation(input: { partyId: string; roles: readonly Role[] }): Promise<AgentConversation>;
}

/** Roles that may talk to the agent. */
export const AGENT_ROLES: readonly Role[] = ['treasurer', 'approver'];

const HISTORY_FOR_MODEL = 20;
const HISTORY_FOR_SCREEN = 100;

const StoredSchema = z.object({
  text: z.string(),
  actions: z.array(ActionCardViewSchema).default([]),
  degraded: z.boolean().default(false),
});

/** Tools whose successful runs go into the activity log (cycles log themselves). */
const LOGGED_TOOLS = new Set([
  'draft_policy',
  'propose_mandate_change',
  'issue_units',
  'invite_holder',
]);

export function degradedText(reason: string): string {
  return `I can't reach the language model right now (${reason}). Nothing was executed. You can still use Run cycle now and the screens.`;
}

function toMessage(row: StoredMessage): AgentMessage | null {
  if (row.role === 'tool') return null;
  const parsed = StoredSchema.safeParse(row.content);
  if (!parsed.success) return null;
  return {
    id: String(row.id),
    role: row.role,
    text: parsed.data.text,
    actions: parsed.data.actions,
    at: row.createdAt.toISOString(),
    degraded: parsed.data.degraded,
  };
}

function historyMessage(message: AgentMessage): LlmMessage {
  if (message.role === 'user') return { role: 'user', content: message.text };
  const done = message.actions.map((a) => a.title);
  const suffix = done.length > 0 ? `\n[Actions taken: ${done.join('; ')}]` : '';
  return { role: 'assistant', content: `${message.text}${suffix}` };
}

function resolveStore(deps: Pick<AgentDeps, 'store' | 'db'>): AgentStore {
  if (deps.store) return deps.store;
  if (deps.db) return createAgentStore(deps.db);
  throw new Error('createAgent needs a db or a store');
}

export function createAgent(deps: AgentDeps): Agent {
  const { llm, services, names, bus, activity } = deps;
  const store = resolveStore(deps);
  const maxRounds = deps.maxToolRounds ?? 4;
  const strict = deps.strictTools ?? false;
  const now = deps.now ?? ((): Date => new Date());
  const queues = new Map<string, Promise<unknown>>();

  async function recordEvent(kind: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await store.recordEvent(kind, payload);
    } catch (error) {
      deps.log?.warn({ err: error }, 'could not record an agent event');
    }
  }

  async function loadMessages(partyId: string, limit: number): Promise<AgentMessage[]> {
    const rows = await store.recentMessages(partyId, limit);
    return rows.map(toMessage).filter((m): m is AgentMessage => m !== null);
  }

  async function insertMessage(
    partyId: string,
    role: 'user' | 'assistant',
    content: { text: string; actions?: ActionCardView[]; degraded?: boolean },
  ): Promise<AgentMessage> {
    const row = await store.insertMessage(partyId, role, {
      text: content.text,
      actions: content.actions ?? [],
      degraded: content.degraded ?? false,
    });
    const message = toMessage(row);
    if (!message) throw new Error('chat message could not be read back');
    return message;
  }

  async function systemPrompt(partyId: string, roles: readonly Role[]): Promise<string> {
    let mandate: MandateView | null | undefined;
    try {
      mandate = await services.org.mandate();
    } catch (error) {
      deps.log?.warn({ err: error }, 'could not read the mandate for the prompt');
      mandate = undefined;
    }
    const parties = await services.org.parties().catch((): PartyRef[] => []);
    return buildSystemPrompt({
      mandate,
      today: now(),
      roles,
      parties,
      partyName: await names.name(partyId),
    });
  }

  async function runTool(
    tool: AgentTool | undefined,
    call: LlmToolCall,
    ctx: ToolContext,
  ): Promise<ToolRun> {
    if (!tool) {
      const message = `The agent asked for "${call.name}", which it is not allowed to use, so nothing was done.`;
      return {
        card: card({ tool: call.name, title: message, status: 'failed' }),
        result: { ok: false, error: message },
      };
    }
    try {
      return await tool.execute(call.arguments, ctx);
    } catch (error) {
      deps.log?.warn({ err: error, tool: tool.name }, 'tool failed');
      const message = messageOf(error);
      return {
        card: card({
          tool: tool.name,
          title: `${tool.name} did not finish`,
          status: 'failed',
          summary: message,
        }),
        result: { ok: false, error: message },
      };
    }
  }

  async function turn(
    partyId: string,
    roles: readonly Role[],
    text: string,
  ): Promise<SendAgentMessageResponse> {
    const allowed = toolsForRoles(roles);
    const userMessage = await insertMessage(partyId, 'user', { text });
    const earlier = (await loadMessages(partyId, HISTORY_FOR_MODEL + 1)).filter(
      (m) => m.id !== userMessage.id,
    );
    const messages: LlmMessage[] = [
      { role: 'system', content: await systemPrompt(partyId, roles) },
      ...earlier.slice(-HISTORY_FOR_MODEL).map(historyMessage),
      { role: 'user', content: text },
    ];
    const llmTools = allowed.map((t) => llmToolOf(t, strict));

    const cards: ActionCardView[] = [];
    const notes: string[] = [];
    const finished = new Map<string, ToolRun>();
    let finalText = '';
    let degraded: string | null = null;

    try {
      for (let round = 0; round <= maxRounds; round += 1) {
        const last = round === maxRounds;
        const answer: LlmTurn = await llm.chat({
          purpose: 'agent.chat',
          messages,
          tools: llmTools,
          toolChoice: last ? 'none' : 'auto',
        });
        if (answer.toolCalls.length === 0 || last) {
          finalText = answer.message.content?.trim() ?? '';
          break;
        }
        messages.push(answer.message);
        const fingerprints: Fingerprint[] = [
          { label: 'agent.request', sha256: answer.requestFingerprint },
          { label: 'agent.response', sha256: answer.responseFingerprint },
        ];
        for (const call of answer.toolCalls) {
          const key = `${call.name}:${call.arguments}`;
          let run = finished.get(key);
          if (!run) {
            const tool = allowed.find((t) => t.name === call.name);
            const ctx: ToolContext = {
              partyId,
              roles,
              userText: text,
              services,
              names,
              fingerprints,
              expiry: deps.expiry,
              scope: deps.scope,
              proposalWaitMs: deps.proposalWaitMs ?? 15_000,
              pollMs: deps.pollMs ?? 250,
              now,
            };
            run = await runTool(tool, call, ctx);
            finished.set(key, run);
            cards.push(run.card);
            notes.push(...(run.replyNotes ?? []));
            if (
              run.card.status === 'failed' &&
              run.card.title.startsWith("The agent's request was malformed")
            ) {
              await recordEvent('llm_invalid_output', { party: partyId, tool: call.name });
            }
          }
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(run.result),
          });
        }
      }
    } catch (error) {
      if (error instanceof LlmInvalidOutputError) {
        degraded = 'the model answered in a form I could not use';
        await recordEvent('llm_invalid_output', { party: partyId, why: error.message });
      } else if (error instanceof LlmUnavailableError) {
        degraded = error.reason;
        await recordEvent('llm_unavailable', { party: partyId, reason: error.reason });
      } else {
        throw error;
      }
    }

    let replyText: string;
    if (degraded !== null) {
      replyText =
        cards.length === 0
          ? degradedText(degraded)
          : `The actions below were done, but I lost contact with the language model afterwards (${degraded}), so I cannot summarize them. Check each card for what happened.`;
    } else {
      replyText = finalText !== '' ? finalText : fallbackText(cards);
    }
    for (const note of notes) {
      if (!replyText.includes(note)) replyText = `${replyText}\n\n${note}`;
    }

    const reply = await insertMessage(partyId, 'assistant', {
      text: replyText,
      actions: cards,
      degraded: degraded !== null,
    });
    for (const action of cards) {
      bus.publish({ type: 'agent', messageId: reply.id, action }, { parties: [partyId] });
    }
    await logActivity(partyId, cards);
    return { user: userMessage, reply };
  }

  async function logActivity(partyId: string, cards: ActionCardView[]): Promise<void> {
    for (const c of cards) {
      if (c.status === 'failed' || !LOGGED_TOOLS.has(c.tool)) continue;
      try {
        await activity.record({
          actorParty: partyId,
          kind: `agent.${c.tool}`,
          subject: c.tool,
          text: `Agent, asked by ${await names.name(partyId)}: ${c.title}`,
          link: c.link,
        });
      } catch (error) {
        deps.log?.warn({ err: error }, 'could not record agent activity');
      }
    }
  }

  return {
    async respond({ partyId, roles, text }) {
      if (!roles.some((r) => AGENT_ROLES.includes(r))) {
        throw new ApiError(
          403,
          'forbidden_role',
          'Only the treasurer and approvers can talk to the agent.',
        );
      }
      // One message at a time per party, so history and cards stay in order.
      const previous = queues.get(partyId) ?? Promise.resolve();
      const run = previous.then(
        () => turn(partyId, roles, text),
        () => turn(partyId, roles, text),
      );
      queues.set(
        partyId,
        run.catch(() => undefined),
      );
      return run;
    },
    async conversation({ partyId, roles }) {
      return {
        messages: await loadMessages(partyId, HISTORY_FOR_SCREEN),
        suggestions: suggestionsFor(roles),
      };
    },
  };
}

function fallbackText(cards: ActionCardView[]): string {
  if (cards.length === 0) return "I don't have an answer for that. Try asking in another way.";
  return `${cards.map((c) => c.title.replace(/\.$/, '')).join('. ')}.`;
}

/** Tool names, for tests and docs. */
export const TOOL_NAMES: readonly string[] = ALL_TOOLS.map((t) => t.name);
