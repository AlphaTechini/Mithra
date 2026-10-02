import { randomUUID } from 'node:crypto';
import { PolicyFieldsSchema, type PolicyDraft, type PolicyFields } from '@mithra/shared';
import { desc, eq } from 'drizzle-orm';
import type { Config } from '../config/env';
import type { Database } from '../db';
import { policyDrafts, type PolicyDraftRow } from '../db/schema';
import { ApiError } from '../http/errors';
import type { Ledger } from '../ledger';
import type { PartyNames } from '../parties/names';
import { describePolicy } from './describe';
import { assertPolicyValid, fieldsFromTerms } from './fields';

/** The id of the draft built from the current Mandate; it is not stored until the treasurer edits it. */
export const CURRENT_MANDATE_DRAFT_ID = 'current-mandate';

export type DraftSource = 'agent' | 'edited';

/** A stored or derived draft with the party it belongs to (used when sealing). */
export interface DraftRecord {
  draft: PolicyDraft;
  party: string;
}

export interface PolicyDrafts {
  /**
   * The treasurer's latest draft; else a draft built from the current Mandate
   * (`source: 'current-mandate'`); else null.
   */
  latest(party: string): Promise<PolicyDraft | null>;
  /** A draft by id, with its owner. `current-mandate` is the draft of the current Mandate. */
  get(draftId: string): Promise<DraftRecord | null>;
  /**
   * Replaces the fields of the treasurer's latest draft (or starts one) as an edit. Validates the
   * fields and recomputes the summary (A1). Never seals anything.
   */
  replace(party: string, fields: PolicyFields): Promise<PolicyDraft>;
  /**
   * For the agent (M5): saves a new draft read from the treasurer's prompt. `party` defaults to
   * the organization's treasurer.
   */
  savePolicyDraft(fields: PolicyFields, source: DraftSource, party?: string): Promise<PolicyDraft>;
}

export interface PolicyDraftDeps {
  config: Pick<Config, 'parties' | 'asset'>;
  db: Database;
  ledger: Pick<Ledger, 'reader'>;
  names: PartyNames;
}

export function createPolicyDrafts(deps: PolicyDraftDeps): PolicyDrafts {
  async function toDraft(
    draftId: string,
    fields: PolicyFields,
    source: PolicyDraft['source'],
    updatedAt: Date,
  ): Promise<PolicyDraft> {
    const names: Record<string, string> = {};
    for (const approver of fields.approvers) names[approver] = await deps.names.name(approver);
    const description = describePolicy(fields, names, deps.config.asset.symbol);
    return {
      draftId,
      fields,
      summary: description.summary,
      agentCan: description.agentCan,
      agentCannot: description.agentCannot,
      source,
      updatedAt: updatedAt.toISOString(),
    };
  }

  async function fromRow(row: PolicyDraftRow): Promise<PolicyDraft> {
    const fields = PolicyFieldsSchema.parse(row.fields);
    return toDraft(row.draftId, fields, row.source, row.updatedAt);
  }

  async function currentMandateDraft(): Promise<DraftRecord | null> {
    const mandate = await deps.ledger.reader.mandate();
    if (!mandate) return null;
    const draft = await toDraft(
      CURRENT_MANDATE_DRAFT_ID,
      fieldsFromTerms(mandate.payload.terms),
      'current-mandate',
      new Date(mandate.payload.sealedAt),
    );
    return { draft, party: mandate.payload.treasurer };
  }

  async function latestRow(party: string): Promise<PolicyDraftRow | null> {
    const [row] = await deps.db
      .select()
      .from(policyDrafts)
      .where(eq(policyDrafts.party, party))
      .orderBy(desc(policyDrafts.updatedAt))
      .limit(1);
    return row ?? null;
  }

  async function organizationTreasurer(): Promise<string> {
    const org = await deps.ledger.reader.organization();
    if (!org) {
      throw new ApiError(
        409,
        'no_organization',
        'There is no organization yet. Create it in step 1 of the setup first.',
      );
    }
    return org.payload.treasurer;
  }

  return {
    async latest(party) {
      const row = await latestRow(party);
      if (row) return fromRow(row);
      return (await currentMandateDraft())?.draft ?? null;
    },

    async get(draftId) {
      if (draftId === CURRENT_MANDATE_DRAFT_ID) return currentMandateDraft();
      const [row] = await deps.db
        .select()
        .from(policyDrafts)
        .where(eq(policyDrafts.draftId, draftId))
        .limit(1);
      if (!row) return null;
      return { draft: await fromRow(row), party: row.party };
    },

    async replace(party, fields) {
      const parsed = PolicyFieldsSchema.parse(fields);
      assertPolicyValid(parsed, deps.config.parties.agent);
      const existing = await latestRow(party);
      const now = new Date();
      if (existing) {
        const [row] = await deps.db
          .update(policyDrafts)
          .set({ fields: parsed, source: 'edited', updatedAt: now })
          .where(eq(policyDrafts.draftId, existing.draftId))
          .returning();
        if (!row) throw new Error('policy_drafts update returned no row');
        return fromRow(row);
      }
      const [row] = await deps.db
        .insert(policyDrafts)
        .values({ draftId: randomUUID(), party, fields: parsed, source: 'edited', updatedAt: now })
        .returning();
      if (!row) throw new Error('policy_drafts insert returned no row');
      return fromRow(row);
    },

    async savePolicyDraft(fields, source, party) {
      const parsed = PolicyFieldsSchema.parse(fields);
      assertPolicyValid(parsed, deps.config.parties.agent);
      const owner = party ?? (await organizationTreasurer());
      const [row] = await deps.db
        .insert(policyDrafts)
        .values({
          draftId: randomUUID(),
          party: owner,
          fields: parsed,
          source,
          updatedAt: new Date(),
        })
        .returning();
      if (!row) throw new Error('policy_drafts insert returned no row');
      return fromRow(row);
    },
  };
}
