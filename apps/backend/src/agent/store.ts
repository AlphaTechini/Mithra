import { desc, eq } from 'drizzle-orm';
import type { Database } from '../db';
import { agentEvents, chatMessages } from '../db/schema';

/** One stored chat row. `content` is `{ text, actions, degraded }` (see agent.ts). */
export interface StoredMessage {
  id: number;
  partyId: string;
  role: 'user' | 'assistant' | 'tool';
  content: unknown;
  createdAt: Date;
}

/** Where the agent keeps its conversations and its diagnostic events (`chat_messages`, `agent_events`). */
export interface AgentStore {
  insertMessage(
    partyId: string,
    role: 'user' | 'assistant',
    content: unknown,
  ): Promise<StoredMessage>;
  /** The newest `limit` messages of `partyId`, oldest first. */
  recentMessages(partyId: string, limit: number): Promise<StoredMessage[]>;
  recordEvent(
    kind: string,
    payload: Record<string, unknown>,
    cycleId?: string | null,
  ): Promise<void>;
}

export function createAgentStore(db: Database): AgentStore {
  return {
    async insertMessage(partyId, role, content) {
      const [row] = await db.insert(chatMessages).values({ partyId, role, content }).returning();
      if (!row) throw new Error('chat_messages insert returned no row');
      return row;
    },
    async recentMessages(partyId, limit) {
      const rows = await db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.partyId, partyId))
        .orderBy(desc(chatMessages.id))
        .limit(limit);
      return rows.reverse();
    },
    async recordEvent(kind, payload, cycleId = null) {
      await db.insert(agentEvents).values({ cycleId, kind, payload });
    },
  };
}

/** In memory, for unit tests that should not need a database. */
export function createMemoryAgentStore(): AgentStore & {
  events: { kind: string; payload: Record<string, unknown>; cycleId: string | null }[];
} {
  const messages: StoredMessage[] = [];
  const events: { kind: string; payload: Record<string, unknown>; cycleId: string | null }[] = [];
  let nextId = 1;
  return {
    events,
    insertMessage(partyId, role, content) {
      const row: StoredMessage = { id: nextId, partyId, role, content, createdAt: new Date() };
      nextId += 1;
      messages.push(row);
      return Promise.resolve(row);
    },
    recentMessages(partyId, limit) {
      return Promise.resolve(messages.filter((m) => m.partyId === partyId).slice(-limit));
    },
    recordEvent(kind, payload, cycleId = null) {
      events.push({ kind, payload, cycleId });
      return Promise.resolve();
    },
  };
}
