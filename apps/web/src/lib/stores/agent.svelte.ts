/**
 * The conversation with the agent, shared by the agent panel and the Agent page. Messages come
 * from `GET /api/agent/messages`; sending posts to `/api/agent/messages` and waits for the reply.
 * While the agent works, each tool call it makes arrives as an `agent` live event and shows as an
 * action card straight away (A10); the final reply replaces those once the request answers.
 */
import type { ActionCardView, AgentMessage as ApiMessage } from '@mithra/shared';
import { describeError } from '$lib/errors';
import { getAgentConversation, sendAgentMessage } from '$lib/api/treasury';
import type { ActionCardData, AgentMessage as UiMessage } from '$lib/types/ui';
import { live } from './live.svelte';

const DEFAULT_SUGGESTIONS = [
  'Distribute 1,200 CC for September.',
  'Why was last cycle flagged?',
  'What did we pay Holder B in Q3?',
  'Raise the cap to 3,000 CC.',
];

/** Maps one API action card to the design system's card data. */
export function toCardData(action: ActionCardView): ActionCardData {
  return {
    id: action.id,
    title: action.title,
    status: action.status,
    ...(action.summary ? { summary: action.summary } : {}),
    details: action.details,
    ...(action.link ? { href: action.link } : {}),
  };
}

/**
 * Flattens API messages into transcript rows: the user's message, then each tool call as a card,
 * then the agent's text. Cards come before the reply because the agent acts, then explains.
 */
export function toUiMessages(messages: readonly ApiMessage[]): UiMessage[] {
  const rows: UiMessage[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      rows.push({ id: message.id, role: 'user', text: message.text });
      continue;
    }
    for (const action of message.actions) {
      rows.push({ id: `${message.id}:${action.id}`, role: 'tool', action: toCardData(action) });
    }
    if (message.text.trim() !== '' || message.degraded) {
      rows.push({ id: message.id, role: 'agent', text: message.text, degraded: message.degraded });
    }
  }
  return rows;
}

interface AgentState {
  messages: ApiMessage[];
  suggestions: string[];
  /** Tool calls that arrived while a reply is still being written. */
  liveActions: ActionCardView[];
  /** The user's text, shown at once while the request is in flight. */
  pendingText: string | null;
  loading: boolean;
  loaded: boolean;
  busy: boolean;
  error: unknown;
  errorWhat: string;
  /** The prompt whose send failed, kept so Retry sends it again instead of losing it. */
  failedPrompt: string | null;
}

const state = $state<AgentState>({
  messages: [],
  suggestions: DEFAULT_SUGGESTIONS,
  liveActions: [],
  pendingText: null,
  loading: false,
  loaded: false,
  busy: false,
  error: null,
  errorWhat: '',
  failedPrompt: null,
});

let unsubscribe: (() => void) | null = null;

function upsertAction(list: ActionCardView[], action: ActionCardView): void {
  const index = list.findIndex((a) => a.id === action.id);
  if (index >= 0) list[index] = action;
  else list.push(action);
}

function onAgentEvent(event: { messageId: string; action: ActionCardView }): void {
  const message = state.messages.find((m) => m.id === event.messageId);
  if (message) upsertAction(message.actions, event.action);
  // Only a running send shows live cards: the reply replaces them. Otherwise one would be an orphan.
  else if (state.busy) upsertAction(state.liveActions, event.action);
}

export const agentStore = {
  get messages(): readonly ApiMessage[] {
    return state.messages;
  },
  /** Transcript rows for the design-system components. */
  get rows(): UiMessage[] {
    const rows = toUiMessages(state.messages);
    if (state.pendingText !== null) {
      rows.push({ id: 'pending-user', role: 'user', text: state.pendingText });
    }
    for (const action of state.liveActions) {
      rows.push({ id: `live:${action.id}`, role: 'tool', action: toCardData(action) });
    }
    return rows;
  },
  get suggestions(): readonly string[] {
    return state.suggestions;
  },
  get busy(): boolean {
    return state.busy;
  },
  get loading(): boolean {
    return state.loading && !state.loaded;
  },
  /** What failed and what to do, or null. */
  get error(): { title: string; message: string } | null {
    return state.error ? describeError(state.error, state.errorWhat) : null;
  },

  /** Loads the conversation once and starts listening for live action cards. */
  async load(): Promise<void> {
    unsubscribe ??= live.subscribe('agent', onAgentEvent);
    if (state.loaded || state.loading) return;
    state.loading = true;
    try {
      const conversation = await getAgentConversation();
      state.messages = conversation.messages;
      state.suggestions =
        conversation.suggestions.length > 0 ? conversation.suggestions : DEFAULT_SUGGESTIONS;
      state.error = null;
      state.loaded = true;
    } catch (e) {
      state.error = e;
      state.errorWhat = "Couldn't load the conversation.";
    } finally {
      state.loading = false;
    }
  },

  /** After a failed send, sends the same prompt again; after any other error, reloads. */
  async retry(): Promise<void> {
    const prompt = state.failedPrompt;
    if (prompt !== null) {
      state.failedPrompt = null;
      await agentStore.send(prompt);
      return;
    }
    state.error = null;
    state.loaded = false;
    await agentStore.load();
  },

  /** Sends a prompt. The reply, with its action cards, arrives when the agent is done. */
  async send(text: string): Promise<void> {
    const value = text.trim();
    if (!value || state.busy) return;
    state.busy = true;
    state.error = null;
    state.failedPrompt = null;
    state.pendingText = value;
    state.liveActions = [];
    try {
      const response = await sendAgentMessage(value);
      // Merge: cards the stream already showed are replaced by the server's final versions.
      state.messages = [...state.messages, response.user, response.reply];
      state.liveActions = [];
    } catch (e) {
      state.error = e;
      state.errorWhat = "The agent couldn't answer.";
      state.failedPrompt = value;
    } finally {
      state.pendingText = null;
      state.busy = false;
    }
  },

  /** Test helper. */
  reset(): void {
    unsubscribe?.();
    unsubscribe = null;
    state.messages = [];
    state.suggestions = DEFAULT_SUGGESTIONS;
    state.liveActions = [];
    state.pendingText = null;
    state.loading = false;
    state.loaded = false;
    state.busy = false;
    state.error = null;
    state.failedPrompt = null;
  },
};
