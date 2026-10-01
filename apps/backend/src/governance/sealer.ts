import { randomUUID } from 'node:crypto';
import type { PolicyFields, SealStatus } from '@mithra/shared';
import { eq } from 'drizzle-orm';
import type { Config } from '../config/env';
import { sha256Hex } from '../cycle/fingerprint';
import { formatAmount } from '../cycle/format';
import type { Database } from '../db';
import { sealRequests, type SealRequestRow } from '../db/schema';
import { ApiError } from '../http/errors';
import type { Contract, Ledger, Mandate, MandateTerms, Organization } from '../ledger';
import type { PartyNames } from '../parties/names';
import { describePolicy } from '../policy/describe';
import { assertPolicyValid, termsFromFields } from '../policy/fields';

/**
 * Sealing a Mandate: the treasurer signs a `MandateSealRequest`; only `Org_ApplySeal`, run with
 * the treasury's authority, turns it into a Mandate (L6). On LocalNet the treasury is a
 * Decentralized Party, so `Org_ApplySeal` runs inside a governed action that needs the governance
 * threshold of node confirmations (N8). On MainNet the treasurer signs in Grofty (M10).
 */
export interface MandateSealer {
  /** Records the treasurer's signed request and starts the governed action. */
  start(draftId: string, treasurer: string): Promise<SealStatus>;
  status(sealId: string): Promise<SealStatus>;
  /** Moves a seal forward (polls confirmations, executes the governed action, detects the seal). */
  advance(sealId: string): Promise<SealStatus>;
  /** Seal requests still waiting for node confirmations. */
  pending(): Promise<string[]>;
}

/** The confirmations the app keeps for a seal request (`seal_requests.confirmations`). */
export interface SealProgress {
  /** Node ids the app confirmed on (autoConfirm nodes). */
  confirmedNodes: string[];
  /** Node ids whose member party appears among DecMan's confirmations. */
  attributedNodes: string[];
  confirmationCids: string[];
  /** Confirmations DecMan reports, whether or not they could be attributed to a node. */
  count: number;
  executedAt: string | null;
  lastError: string | null;
}

export function emptyProgress(): SealProgress {
  return {
    confirmedNodes: [],
    attributedNodes: [],
    confirmationCids: [],
    count: 0,
    executedAt: null,
    lastError: null,
  };
}

export function progressOf(row: Pick<SealRequestRow, 'confirmations'>): SealProgress {
  const raw = row.confirmations as Partial<SealProgress> | null;
  return {
    confirmedNodes: Array.isArray(raw?.confirmedNodes) ? raw.confirmedNodes : [],
    attributedNodes: Array.isArray(raw?.attributedNodes) ? raw.attributedNodes : [],
    confirmationCids: Array.isArray(raw?.confirmationCids) ? raw.confirmationCids : [],
    count: typeof raw?.count === 'number' ? raw.count : 0,
    executedAt: typeof raw?.executedAt === 'string' ? raw.executedAt : null,
    lastError: typeof raw?.lastError === 'string' ? raw.lastError : null,
  };
}

/** Storage of seal requests; PostgreSQL in the app, memory in unit tests. */
export interface SealStore {
  insert(row: Omit<SealRequestRow, 'createdAt' | 'updatedAt'>): Promise<SealRequestRow>;
  get(sealId: string): Promise<SealRequestRow | null>;
  update(
    sealId: string,
    patch: Partial<Omit<SealRequestRow, 'sealId' | 'createdAt'>>,
  ): Promise<SealRequestRow>;
  pendingIds(): Promise<string[]>;
}

export function createSealStore(db: Database): SealStore {
  return {
    async insert(row) {
      const [inserted] = await db.insert(sealRequests).values(row).returning();
      if (!inserted) throw new Error('seal_requests insert returned no row');
      return inserted;
    },
    async get(sealId) {
      const [row] = await db.select().from(sealRequests).where(eq(sealRequests.sealId, sealId));
      return row ?? null;
    },
    async update(sealId, patch) {
      const [row] = await db
        .update(sealRequests)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(sealRequests.sealId, sealId))
        .returning();
      if (!row) throw new ApiError(404, 'seal_not_found', `There is no seal request ${sealId}.`);
      return row;
    },
    async pendingIds() {
      const rows = await db
        .select({ sealId: sealRequests.sealId })
        .from(sealRequests)
        .where(eq(sealRequests.state, 'awaiting-nodes'));
      return rows.map((r) => r.sealId);
    },
  };
}

/** The draft the sealer reads. */
export interface DraftSource {
  get(draftId: string): Promise<{ draft: { fields: PolicyFields }; party: string } | null>;
}

/** What the sealer needs to know to seal a draft. */
export interface PreparedSeal {
  fields: PolicyFields;
  terms: MandateTerms;
  summary: string;
  summaryFingerprint: string;
  organization: Contract<Organization>;
  currentMandate: Contract<Mandate> | null;
  /** The Mandate version this seal creates. */
  nextVersion: number;
  /** "Seal Mandate v2: cap 5,000 CC, 2 of 3 approvals". */
  description: string;
}

export interface SealPrepareDeps {
  config: Pick<Config, 'parties' | 'asset'>;
  ledger: Pick<Ledger, 'reader'>;
  drafts: DraftSource;
  names: PartyNames;
}

/** Validates the draft and builds the terms, the summary and its fingerprint (A1: sealed text = shown text). */
export async function prepareSeal(
  deps: SealPrepareDeps,
  draftId: string,
  treasurer: string,
): Promise<PreparedSeal> {
  const organization = await deps.ledger.reader.organization();
  if (!organization) {
    throw new ApiError(
      409,
      'no_organization',
      'There is no organization yet. Create it in step 1 of the setup before sealing a Mandate.',
    );
  }
  if (organization.payload.treasurer !== treasurer) {
    throw new ApiError(403, 'not_treasurer', 'Only the treasurer can seal the Mandate.');
  }
  const record = await deps.drafts.get(draftId);
  if (!record) {
    throw new ApiError(
      404,
      'draft_not_found',
      'That policy draft no longer exists. Draft the policy again, then seal it.',
    );
  }
  if (record.party !== treasurer) {
    throw new ApiError(403, 'not_your_draft', 'That draft belongs to someone else.');
  }
  const fields = record.draft.fields;
  assertPolicyValid(fields, deps.config.parties.agent);
  const names: Record<string, string> = {};
  for (const approver of fields.approvers) names[approver] = await deps.names.name(approver);
  const summary = describePolicy(fields, names, deps.config.asset.symbol).summary;
  const currentMandate = await deps.ledger.reader.mandate();
  const nextVersion = organization.payload.mandateVersion + 1;
  return {
    fields,
    terms: termsFromFields(fields, organization.payload.asset),
    summary,
    summaryFingerprint: sha256Hex(summary),
    organization,
    currentMandate,
    nextVersion,
    description: `Seal Mandate v${nextVersion}: cap ${formatAmount(fields.cap, deps.config.asset.symbol)}, ${fields.approvalThreshold} of ${fields.approvers.length} approvals`,
  };
}

/** Creates a new seal request id. */
export function newSealId(): string {
  return randomUUID();
}

/** The API status of a stored seal request. `config` supplies the node names (LocalNet). */
export function sealStatusOf(
  row: SealRequestRow,
  config: Pick<Config, 'network' | 'localnet'>,
): SealStatus {
  const progress = progressOf(row);
  const local = config.network === 'localnet' ? config.localnet : undefined;
  const nodes =
    local && row.state !== 'awaiting-signature'
      ? local.nodes.map((n) => ({
          id: n.id,
          name: n.name,
          operator: n.operator,
          confirmed:
            progress.confirmedNodes.includes(n.id) || progress.attributedNodes.includes(n.id),
        }))
      : null;
  return {
    sealId: row.sealId,
    state: row.state,
    treasurerSigned: row.sealRequestCid !== null,
    nodeConfirmations:
      local && nodes
        ? {
            required: local.decmanGovernanceThreshold,
            confirmed: Math.max(nodes.filter((n) => n.confirmed).length, progress.count),
            nodes,
          }
        : null,
    mandateVersion: row.mandateVersion,
    error: row.error,
  };
}
