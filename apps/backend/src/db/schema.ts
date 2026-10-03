import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  index,
  integer,
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
    /** The treasury of the timeline events of a cycle; null for events that are not per treasury. */
    orgTreasury: text('org_treasury'),
    cycleId: text('cycle_id'),
    kind: text('kind').notNull(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('agent_events_cycle_idx').on(t.cycleId, t.id),
    index('agent_events_treasury_cycle_idx').on(t.orgTreasury, t.cycleId, t.id),
  ],
);

/**
 * One row per cycle. The unique key means a restart cannot run a cycle twice; a new attempt after a
 * failure, rejection or cancellation reuses the row (see `CycleService.run`).
 *
 * `status`: running (preparing), proposed (a Proposal waits: countdown, held, approvals or funds),
 * executing (the payout submission is in flight), executed, failed, rejected, cancelled. `held`
 * pauses the countdown without a status of its own (the UI status is derived from the ledger).
 */
export const cycleRuns = pgTable(
  'cycle_runs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgTreasury: text('org_treasury').notNull(),
    cycleId: text('cycle_id').notNull(),
    status: text('status', {
      enum: [
        'running',
        'proposed',
        'executed',
        'failed',
        'held',
        'executing',
        'rejected',
        'cancelled',
      ],
    }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    error: text('error'),
    /** Last change; a stale `running` or `executing` row is recovered by the reconciler. */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** schedule, prompt or manual. */
    trigger: text('trigger', { enum: ['schedule', 'prompt', 'manual'] })
      .notNull()
      .default('manual'),
    triggerDetail: text('trigger_detail').notNull().default(''),
    /** Requested or proposed total, a decimal string; null until it is known. */
    total: text('total'),
    recordDate: text('record_date'),
    /** End of the Hold countdown for an auto-execute proposal (U6). */
    executesAt: timestamp('executes_at', { withTimezone: true }),
    /** True while a person holds the countdown (U6). */
    held: boolean('held').notNull().default(false),
    /** Set when the live balance is below total plus fee buffer: { balance, required } (P5). */
    fundsShortfall: jsonb('funds_shortfall'),
    /**
     * True once the engine looked at the ready proposal and found payees without a MainNet wallet
     * (the `needs-wallets` status, shown only after the engine recorded it, like a shortfall).
     */
    waitingForWallets: boolean('waiting_for_wallets').notNull().default(false),
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

/** Policy drafts the treasurer reviews before sealing (A1): the agent's reading of a prompt, or edits. */
export const policyDrafts = pgTable(
  'policy_drafts',
  {
    draftId: text('draft_id').primaryKey(),
    /** The treasurer the draft belongs to. */
    party: text('party').notNull(),
    fields: jsonb('fields').notNull(),
    source: text('source', { enum: ['agent', 'edited', 'current-mandate'] }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('policy_drafts_party_idx').on(t.party, t.updatedAt)],
);

/** Progress of sealing a Mandate: the treasurer's request and the governed action (L6, N8). */
export const sealRequests = pgTable(
  'seal_requests',
  {
    sealId: text('seal_id').primaryKey(),
    draftId: text('draft_id').notNull(),
    treasurer: text('treasurer').notNull(),
    sealRequestCid: text('seal_request_cid'),
    governanceProposalCid: text('governance_proposal_cid'),
    state: text('state', {
      enum: ['awaiting-nodes', 'sealed', 'failed'],
    }).notNull(),
    /** { confirmedNodes: string[], confirmationCids: string[], executedAt: string | null } */
    confirmations: jsonb('confirmations')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Mandate version before this seal; the seal is done when the organization's version is higher. */
    baseVersion: integer('base_version').notNull().default(0),
    /** The version this seal created, once sealed. */
    mandateVersion: integer('mandate_version'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('seal_requests_state_idx').on(t.state)],
);

/**
 * A holder's MainNet party (M10): the Grofty wallet payouts go to. One row per holder, written when
 * the holder proves control of the wallet by signing a challenge message (`signMessage`).
 */
export const mainnetWallets = pgTable('mainnet_wallets', {
  /** The holder's party on the LocalNet records ledger. */
  holderParty: text('holder_party').primaryKey(),
  mainnetParty: text('mainnet_party').notNull(),
  publicKey: text('public_key').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull().defaultNow(),
});

export type MainnetWalletRow = typeof mainnetWallets.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type InviteRow = typeof invites.$inferSelect;
export type NewInviteRow = typeof invites.$inferInsert;
export type CycleRunRow = typeof cycleRuns.$inferSelect;
export type PolicyDraftRow = typeof policyDrafts.$inferSelect;
export type SealRequestRow = typeof sealRequests.$inferSelect;
