import { z } from 'zod';
import { DecimalString } from '../decimal';
import { PartyRefSchema, TxLinkSchema } from './treasury';

/**
 * API contract for the audit flow (userflow.md section 11, specs L8, L9, A8, A9).
 * The auditor sees record contents only through an active grant; before that, only the scope:
 * record ids, a label and the reason each record was proposed.
 */

export const AuditRecordKindSchema = z.enum(['decision', 'outcome']);
export type AuditRecordKind = z.infer<typeof AuditRecordKindSchema>;

export const ScopeItemViewSchema = z.object({
  recordId: z.string(),
  kind: AuditRecordKindSchema,
  /** e.g. "Decision record, September 2026". */
  label: z.string(),
  /** One line from the agent (or the rules fallback) on why this record answers the question. */
  reason: z.string(),
});
export type ScopeItemView = z.infer<typeof ScopeItemViewSchema>;

/** POST /api/audit/scope/draft { question } → the agent's proposed scope (A8). */
export const DraftScopeRequestSchema = z.object({ question: z.string().trim().min(1).max(2000) });
export type DraftScopeRequest = z.infer<typeof DraftScopeRequestSchema>;
export const ScopeDraftSchema = z.object({
  items: z.array(ScopeItemViewSchema),
  /** e.g. "Holder identities are shown as Holder A to D unless you ask for them." */
  excluded: z.string(),
  source: z.enum(['ai', 'rules']),
  /** Set when the model was unavailable and the rules drafted the scope (A11). */
  notice: z.string().nullable(),
});
export type ScopeDraft = z.infer<typeof ScopeDraftSchema>;

/** POST /api/audit/requests (auditor): creates the AuditRequest on the ledger. */
export const CreateAuditRequestSchema = z.object({
  question: z.string().trim().min(1).max(2000),
  items: z
    .array(
      z.object({
        recordId: z.string().min(1),
        kind: AuditRecordKindSchema,
        reason: z.string().max(500),
      }),
    )
    .min(1)
    .max(200),
  excluded: z.string().max(1000),
});
export type CreateAuditRequest = z.infer<typeof CreateAuditRequestSchema>;

export const AuditRequestStatusSchema = z.enum([
  'pending',
  'granted',
  'denied',
  'withdrawn',
  'ended',
]);
export type AuditRequestStatus = z.infer<typeof AuditRequestStatusSchema>;

export const GrantViewSchema = z.object({
  grantId: z.string(),
  grantedAt: z.string(),
  expiresAt: z.string(),
  recordIds: z.array(z.string()),
  /** Set once the grant is closed: by expiry (the agent) or revoked by the treasurer. */
  closedAt: z.string().nullable(),
  closedReason: z.enum(['expired', 'revoked']).nullable(),
});
export type GrantView = z.infer<typeof GrantViewSchema>;

export const AuditRequestViewSchema = z.object({
  requestId: z.string(),
  auditor: PartyRefSchema,
  question: z.string(),
  scope: z.array(ScopeItemViewSchema),
  excluded: z.string(),
  requestedAt: z.string(),
  status: AuditRequestStatusSchema,
  grant: GrantViewSchema.nullable(),
  denial: z.object({ reason: z.string(), at: z.string() }).nullable(),
});
export type AuditRequestView = z.infer<typeof AuditRequestViewSchema>;

/** GET /api/audit/requests: the auditor's own requests, or all requests for the treasurer. */
export const AuditRequestsResponseSchema = z.object({ requests: z.array(AuditRequestViewSchema) });
export type AuditRequestsResponse = z.infer<typeof AuditRequestsResponseSchema>;

/** What the treasurer reviews before granting: each record that would be shared, side by side with the question. */
export const RecordPreviewSchema = z.object({
  recordId: z.string(),
  kind: AuditRecordKindSchema,
  label: z.string(),
  /** One line of what the record contains, e.g. "1,200 CC to 4 holders, flagged, approved 2 of 3". */
  summary: z.string(),
  /** False when the record id in the scope no longer matches a record on the ledger. */
  available: z.boolean(),
});
export type RecordPreview = z.infer<typeof RecordPreviewSchema>;

/** GET /api/audit/requests/:requestId (treasurer: with `preview`; auditor: `preview` is null). */
export const AuditRequestDetailSchema = z.object({
  request: AuditRequestViewSchema,
  preview: z.array(RecordPreviewSchema).nullable(),
});
export type AuditRequestDetail = z.infer<typeof AuditRequestDetailSchema>;

/** POST /api/audit/requests/:requestId/grant (treasurer). `recordIds` defaults to the whole scope. */
export const GrantAccessRequestSchema = z.object({
  expiresIn: z.enum(['24h', '7d', '30d']),
  recordIds: z.array(z.string().min(1)).min(1).optional(),
});
export type GrantAccessRequest = z.infer<typeof GrantAccessRequestSchema>;
/** POST /api/audit/requests/:requestId/deny (treasurer). */
export const DenyAccessRequestSchema = z.object({ reason: z.string().trim().min(1).max(500) });
export type DenyAccessRequest = z.infer<typeof DenyAccessRequestSchema>;
// POST /api/audit/grants/:grantId/revoke (treasurer) → AuditRequestDetail
// POST /api/audit/requests/:requestId/withdraw (auditor) → AuditRequestDetail

/** One shared record in the evidence room, read from the auditor's own SharedRecord contracts (L8). */
export const EvidenceRecordSchema = z.object({
  recordId: z.string(),
  kind: AuditRecordKindSchema,
  cycleLabel: z.string(),
  decision: z
    .object({
      trigger: z.string(),
      recordDate: z.string(),
      total: DecimalString,
      /** Holders are labelled "Holder A", "Holder B"… in party-id order unless the request asked for identities. */
      payouts: z.array(
        z.object({ holderLabel: z.string(), units: z.number().int(), amount: DecimalString }),
      ),
      inputFingerprints: z.array(z.object({ label: z.string(), sha256: z.string() })),
      modelFingerprints: z.array(z.object({ label: z.string(), sha256: z.string() })),
      checks: z.array(
        z.object({
          label: z.string(),
          passed: z.boolean(),
          blocking: z.boolean(),
          actual: z.string(),
          limit: z.string(),
          source: z.string(),
        }),
      ),
      memo: z.string(),
      verdict: z.enum(['within-mandate', 'needs-approval']),
      mandateVersion: z.number().int(),
      cap: DecimalString,
      createdAt: z.string(),
    })
    .nullable(),
  outcome: z
    .object({
      kind: z.enum(['executed', 'rejected', 'cancelled']),
      approvals: z.array(z.object({ approverLabel: z.string(), at: z.string(), note: z.string() })),
      payments: z.array(
        z.object({
          holderLabel: z.string(),
          amount: DecimalString,
          status: z.string(),
          link: TxLinkSchema.nullable(),
        }),
      ),
      reason: z.string().nullable(),
      at: z.string(),
    })
    .nullable(),
});
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

/** GET /api/audit/grants/:grantId/evidence (auditor). After expiry: 410 `access_ended`. */
export const EvidenceRoomSchema = z.object({
  grantId: z.string(),
  question: z.string(),
  grantedAt: z.string(),
  expiresAt: z.string(),
  records: z.array(EvidenceRecordSchema),
});
export type EvidenceRoom = z.infer<typeof EvidenceRoomSchema>;
// GET /api/audit/grants/:grantId/export → text/markdown summary for working papers (auditor).
