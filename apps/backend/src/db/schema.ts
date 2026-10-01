import { sql } from 'drizzle-orm';
import {
  bigserial,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/** Cookie sessions. `party_id` is null until a party is chosen (LocalNet) or signed in (MainNet). */
export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  partyId: text('party_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/** Invitations for holders and auditors. */
export const invites = pgTable('invites', {
  code: text('code').primaryKey(),
  kind: text('kind', { enum: ['holder', 'auditor'] }).notNull(),
  partyId: text('party_id'),
  displayName: text('display_name').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  usedAt: timestamp('used_at', { withTimezone: true }),
});

/** Chat history of the agent conversation, per party. */
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    partyId: text('party_id').notNull(),
    role: text('role', { enum: ['user', 'assistant', 'tool'] }).notNull(),
    content: jsonb('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('chat_messages_party_idx').on(t.partyId, t.id)],
);

/** The live timeline of what the agent is doing. */
export const agentEvents = pgTable(
  'agent_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    cycleId: text('cycle_id'),
    kind: text('kind').notNull(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agent_events_cycle_idx').on(t.cycleId, t.id)],
);

/** One row per cycle run. The unique key means a restart cannot run a cycle twice. */
export const cycleRuns = pgTable(
  'cycle_runs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgTreasury: text('org_treasury').notNull(),
    cycleId: text('cycle_id').notNull(),
    status: text('status', {
      enum: ['running', 'proposed', 'executed', 'failed', 'held'],
    }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [unique('cycle_runs_org_cycle_unique').on(t.orgTreasury, t.cycleId)],
);

/** Transaction references for explorer links, by the contract they created. */
export const txRefs = pgTable(
  'tx_refs',
  {
    contractId: text('contract_id').notNull(),
    updateId: text('update_id').notNull(),
    kind: text('kind').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.contractId, t.kind] }),
    index('tx_refs_update_idx').on(t.updateId),
  ],
);

/** Who did what in the app, for the activity views. */
export const activityLog = pgTable(
  'activity_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorParty: text('actor_party').notNull(),
    kind: text('kind').notNull(),
    subject: text('subject').notNull(),
    detail: jsonb('detail')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('activity_log_created_idx').on(t.createdAt)],
);

export type SessionRow = typeof sessions.$inferSelect;
export type InviteRow = typeof invites.$inferSelect;
export type NewInviteRow = typeof invites.$inferInsert;
export type CycleRunRow = typeof cycleRuns.$inferSelect;
