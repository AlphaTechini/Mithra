import { z } from 'zod';
import { DecimalString } from '../decimal';

/**
 * API contract for the treasurer, approver and holder screens (userflow.md sections 4 to 10, 12).
 * Amounts are decimal strings. Dates are ISO strings ("2026-09-30" for dates, full ISO for times).
 * Every party shown to a holder is that holder; holder endpoints never carry another holder's data.
 */

const PartyId = z.string().min(1);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const IsoTime = z.string().min(1);

export const PartyRefSchema = z.object({ partyId: PartyId, displayName: z.string() });
export type PartyRef = z.infer<typeof PartyRefSchema>;

/** A link to a payment's transaction: explorer on MainNet, in-app detail on LocalNet (P3). */
export const TxLinkSchema = z.object({
  updateId: z.string(),
  href: z.string(),
  external: z.boolean(),
});
export type TxLink = z.infer<typeof TxLinkSchema>;

// ---------------------------------------------------------------------------------------------
// Organization and setup (userflow 4, 12)

/** Where the treasurer is in first-time setup. */
export const SetupStepSchema = z.enum([
  /** No TreasuryCharter yet (run scripts/localnet-up.sh; the records live on LocalNet on both networks). */
  'charter',
  'organization',
  'policy',
  'mandate',
  'done',
]);
export type SetupStep = z.infer<typeof SetupStepSchema>;

export const MandateTermsViewSchema = z.object({
  cap: DecimalString,
  approvers: z.array(PartyRefSchema),
  approvalThreshold: z.number().int().positive(),
  assetSymbol: z.string(),
  scheduleCron: z.string(),
  scheduleTimezone: z.string(),
  /** Plain English, e.g. "Monthly on the 1st at 09:00 UTC". */
  scheduleText: z.string(),
  recordDateRule: z.string(),
  /** Plain English, e.g. "Last day of the previous month". */
  recordDateText: z.string(),
  fixedAmount: DecimalString.nullable(),
  deviationPct: DecimalString,
  trailingCycles: z.number().int().positive(),
  unitChangePct: DecimalString,
  unitChangeWindowDays: z.number().int().positive(),
  feeBuffer: DecimalString,
});
export type MandateTermsView = z.infer<typeof MandateTermsViewSchema>;

export const MandateViewSchema = z.object({
  version: z.number().int().positive(),
  terms: MandateTermsViewSchema,
  /** LocalNet: the agent executes within the cap. MainNet: the treasurer signs payouts in Grofty. */
  agentExecutes: z.boolean(),
  sealedAt: IsoTime,
  sealedBy: PartyRefSchema,
  executedCycles: z.array(z.string()),
  /** Seal ring: required and actual signatures, from the ledger (U3). Treasurer only: 1 of 1. */
  seal: z.object({ required: z.number().int(), signed: z.number().int() }),
});
export type MandateView = z.infer<typeof MandateViewSchema>;

/** GET /api/org (treasurer, approver). */
export const OrgResponseSchema = z.object({
  setupStep: SetupStepSchema,
  organization: z
    .object({
      name: z.string(),
      treasury: PartyRefSchema,
      treasurer: PartyRefSchema,
      approvers: z.array(PartyRefSchema),
      approvalThreshold: z.number().int().positive(),
      assetSymbol: z.string(),
    })
    .nullable(),
  mandate: MandateViewSchema.nullable(),
});
export type OrgResponse = z.infer<typeof OrgResponseSchema>;

/** POST /api/org (treasurer): Charter_CreateOrganization. */
export const CreateOrgRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  approvers: z.array(PartyId).min(1).max(10),
  approvalThreshold: z.number().int().positive(),
});
export type CreateOrgRequest = z.infer<typeof CreateOrgRequestSchema>;

/** Editable policy before sealing (A1). Same fields as the terms, approvers as party ids. */
export const PolicyFieldsSchema = z.object({
  cap: DecimalString,
  approvers: z.array(PartyId).min(1),
  approvalThreshold: z.number().int().positive(),
  scheduleCron: z.string().min(1),
  scheduleTimezone: z.string().min(1),
  recordDateRule: z.enum(['last_day_of_previous_month', 'day_before_payment']),
  fixedAmount: DecimalString.nullable(),
  deviationPct: DecimalString,
  trailingCycles: z.number().int().positive(),
  unitChangePct: DecimalString,
  unitChangeWindowDays: z.number().int().positive(),
  feeBuffer: DecimalString,
});
export type PolicyFields = z.infer<typeof PolicyFieldsSchema>;

/** GET/PUT /api/policy/draft: the draft the treasurer reviews before sealing. Never applied on its own. */
export const PolicyDraftSchema = z.object({
  draftId: z.string(),
  fields: PolicyFieldsSchema,
  /** Plain-English summary; recomputed by the server from the fields after every edit. */
  summary: z.string(),
  /** "The agent can" / "The agent cannot" lines for the seal step. */
  agentCan: z.array(z.string()),
  agentCannot: z.array(z.string()),
  /** Where the draft came from: the agent's reading of a prompt, or edits. */
  source: z.enum(['agent', 'edited', 'current-mandate']),
  updatedAt: IsoTime,
});
export type PolicyDraft = z.infer<typeof PolicyDraftSchema>;

/** POST /api/policy/draft { prompt } → PolicyDraft (the agent drafts; M5). PUT replaces fields. */
export const DraftPolicyRequestSchema = z.object({ prompt: z.string().trim().min(1).max(2000) });
export type DraftPolicyRequest = z.infer<typeof DraftPolicyRequestSchema>;
export const UpdatePolicyDraftRequestSchema = z.object({ fields: PolicyFieldsSchema });
export type UpdatePolicyDraftRequest = z.infer<typeof UpdatePolicyDraftRequestSchema>;

/** Progress of sealing a Mandate (L6, N8). */
export const SealStatusSchema = z.object({
  sealId: z.string(),
  state: z.enum([
    /** The governed action is waiting for treasury node confirmations. */
    'awaiting-nodes',
    'sealed',
    'failed',
  ]),
  treasurerSigned: z.boolean(),
  /** Node confirmations for the governed action; null before the request is recorded. */
  nodeConfirmations: z
    .object({
      required: z.number().int(),
      confirmed: z.number().int(),
      nodes: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          operator: z.string(),
          confirmed: z.boolean(),
        }),
      ),
    })
    .nullable(),
  mandateVersion: z.number().int().nullable(),
  error: z.string().nullable(),
});
export type SealStatus = z.infer<typeof SealStatusSchema>;

/** POST /api/mandate/seal { draftId } → SealStatus; GET /api/mandate/seal/:sealId → SealStatus. */
export const SealMandateRequestSchema = z.object({ draftId: z.string().min(1) });
export type SealMandateRequest = z.infer<typeof SealMandateRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Holders (userflow 5) and invitations

export const HolderRowSchema = z.object({
  holder: PartyRefSchema,
  units: z.number().int(),
  /** Share of all units, as a decimal string percentage with 2 places, e.g. "33.33". */
  sharePct: DecimalString,
  /** Null when it could not be determined (registry unreachable). */
  autoReceive: z.boolean().nullable(),
  unitsAccepted: z.boolean(),
  /** MainNet: the holder's connected Grofty party, or null when not connected. Absent on LocalNet. */
  mainnetWallet: z.object({ partyId: z.string() }).nullable().optional(),
  lastPayment: z.object({ amount: DecimalString, at: IsoTime, cycleLabel: z.string() }).nullable(),
  seeded: z.boolean(),
});
export type HolderRow = z.infer<typeof HolderRowSchema>;

/** GET /api/holders (treasurer, approver). */
export const HoldersResponseSchema = z.object({
  totalUnits: z.number().int(),
  holders: z.array(HolderRowSchema),
});
export type HoldersResponse = z.infer<typeof HoldersResponseSchema>;

/** POST /api/holders/issue (treasurer): Org_IssueUnits. */
export const IssueUnitsRequestSchema = z.object({
  holder: PartyId,
  units: z.number().int().positive().max(1_000_000_000),
  /** Defaults to today. Cannot be in the future. */
  effectiveDate: IsoDate.optional(),
});
export type IssueUnitsRequest = z.infer<typeof IssueUnitsRequestSchema>;

/** POST /api/invites (treasurer). */
export const CreateInviteRequestSchema = z.object({
  kind: z.enum(['holder', 'auditor']),
  displayName: z.string().trim().min(1).max(80),
  /** LocalNet: the demo party the invite is for. MainNet: omitted; bound on first connect. */
  partyId: PartyId.optional(),
});
export type CreateInviteRequest = z.infer<typeof CreateInviteRequestSchema>;
export const InviteSchema = z.object({
  code: z.string(),
  kind: z.enum(['holder', 'auditor']),
  displayName: z.string(),
  /** Path the invitee opens, e.g. "/invite/AB12CD". */
  path: z.string(),
  orgName: z.string(),
  used: z.boolean(),
  /** Holder invites: units issued to the invited party, when known. */
  unitsOffered: z.number().int().nullable(),
});
export type Invite = z.infer<typeof InviteSchema>;

// ---------------------------------------------------------------------------------------------
// Cycles, proposals, checks (userflow 7, 9, 10)

export const CycleStatusSchema = z.enum([
  'running',
  /** Within the mandate; the Hold countdown is running (U6). */
  'countdown',
  'held',
  'awaiting-approval',
  'executing',
  'paid-automatically',
  'paid-after-approval',
  /** Executed, and at least one payment waits for the holder to accept (P2). */
  'awaiting-acceptance',
  'rejected',
  'cancelled',
  'failed',
  /** Blocked before execution: balance below total plus fee buffer (P5). */
  'needs-funds',
  /** MainNet: authorized on the ledger; the treasurer signs each payout in Grofty (P4: not paid yet). */
  'awaiting-signature',
  /** MainNet: ready to pay, but some holders have not connected Grofty Wallet. */
  'needs-wallets',
]);
export type CycleStatus = z.infer<typeof CycleStatusSchema>;

export const CheckViewSchema = z.object({
  code: z.string(),
  label: z.string(),
  passed: z.boolean(),
  blocking: z.boolean(),
  /** Actual values, e.g. "Total 1,200 CC vs 3-cycle average 410 CC, +193%". */
  actual: z.string(),
  limit: z.string(),
  source: z.enum(['deterministic', 'ai']),
});
export type CheckView = z.infer<typeof CheckViewSchema>;

export const TimelineStepSchema = z.object({
  id: z.enum(['woke', 'snapshot', 'amounts', 'checks', 'review', 'verdict', 'execute']),
  label: z.string(),
  status: z.enum(['pending', 'running', 'done', 'failed']),
  detail: z.string().nullable(),
  at: IsoTime.nullable(),
});
export type TimelineStep = z.infer<typeof TimelineStepSchema>;

export const PaymentViewSchema = z.object({
  status: z.enum(['pending-ledger', 'paid', 'awaiting-acceptance']),
  link: TxLinkSchema.nullable(),
});
export type PaymentView = z.infer<typeof PaymentViewSchema>;

export const PayoutRowSchema = z.object({
  holder: PartyRefSchema,
  units: z.number().int(),
  sharePct: DecimalString,
  amount: DecimalString,
  payment: PaymentViewSchema.nullable(),
});
export type PayoutRow = z.infer<typeof PayoutRowSchema>;

export const ApprovalViewSchema = z.object({
  approver: PartyRefSchema,
  at: IsoTime,
  note: z.string(),
});
export type ApprovalView = z.infer<typeof ApprovalViewSchema>;

export const CycleSummarySchema = z.object({
  cycleId: z.string(),
  label: z.string(),
  status: CycleStatusSchema,
  total: DecimalString.nullable(),
  recordDate: IsoDate.nullable(),
  /** True ledger counts (U3). */
  approvals: z.object({ have: z.number().int(), need: z.number().int() }).nullable(),
  flagCount: z.number().int(),
  trigger: z.enum(['schedule', 'prompt', 'manual']),
  createdAt: IsoTime,
  seeded: z.boolean(),
});
export type CycleSummary = z.infer<typeof CycleSummarySchema>;

/** GET /api/cycles */
export const CyclesResponseSchema = z.object({ cycles: z.array(CycleSummarySchema) });
export type CyclesResponse = z.infer<typeof CyclesResponseSchema>;

export const DecisionRecordViewSchema = z.object({
  recordId: z.string(),
  trigger: z.enum(['schedule', 'prompt', 'manual']),
  triggerDetail: z.string(),
  inputFingerprints: z.array(z.object({ label: z.string(), sha256: z.string() })),
  modelFingerprints: z.array(z.object({ label: z.string(), sha256: z.string() })),
  checks: z.array(CheckViewSchema),
  memo: z.string(),
  memoSource: z.string(),
  verdict: z.enum(['within-mandate', 'needs-approval']),
  mandateVersion: z.number().int(),
  cap: DecimalString,
  createdAt: IsoTime,
});
export type DecisionRecordView = z.infer<typeof DecisionRecordViewSchema>;

/** GET /api/cycles/:cycleId */
export const CycleDetailSchema = z.object({
  summary: CycleSummarySchema,
  timeline: z.array(TimelineStepSchema),
  proposal: z
    .object({
      proposalId: z.string(),
      total: DecimalString,
      recordDate: IsoDate,
      verdict: z.enum(['within-mandate', 'needs-approval']),
      /** Plain-English reasons when approval is needed, e.g. "Total is above the 5,000 CC cap". */
      verdictReasons: z.array(z.string()),
      payouts: z.array(PayoutRowSchema),
      checks: z.array(CheckViewSchema),
      memo: z.string(),
      memoSource: z.string(),
      approvals: z.array(ApprovalViewSchema),
      approvalThreshold: z.number().int(),
      approvers: z.array(PartyRefSchema),
      decisionRecordId: z.string(),
    })
    .nullable(),
  decisionRecord: DecisionRecordViewSchema.nullable(),
  /** Hold countdown for within-mandate proposals (U6). */
  countdown: z.object({ executesAt: IsoTime, held: z.boolean() }).nullable(),
  outcome: z
    .object({
      kind: z.enum(['executed', 'rejected', 'cancelled']),
      actor: PartyRefSchema,
      reason: z.string().nullable(),
      at: IsoTime,
    })
    .nullable(),
  /** Set when the balance check blocks execution (P5): "Add funds" state. */
  fundsShortfall: z.object({ balance: DecimalString, required: DecimalString }).nullable(),
  /** MainNet, status `needs-wallets`: the holders who must connect Grofty Wallet. */
  needsWallets: z.array(PartyRefSchema).optional(),
  error: z.string().nullable(),
});
export type CycleDetail = z.infer<typeof CycleDetailSchema>;

/** POST /api/cycles/run (treasurer): "Run cycle now". All fields optional; defaults from the schedule. */
export const RunCycleRequestSchema = z.object({
  /** e.g. "2026-09" */
  cycleId: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  total: DecimalString.optional(),
  recordDate: IsoDate.optional(),
});
export type RunCycleRequest = z.infer<typeof RunCycleRequestSchema>;
export const RunCycleResponseSchema = z.object({ cycleId: z.string() });
export type RunCycleResponse = z.infer<typeof RunCycleResponseSchema>;

/** POST /api/proposals/:proposalId/approve (approver). Response: the updated cycle detail. */
export const ApproveRequestSchema = z.object({ note: z.string().max(500).default('') });
export type ApproveRequest = z.infer<typeof ApproveRequestSchema>;
/** POST /api/proposals/:proposalId/reject (approver). */
export const RejectRequestSchema = z.object({ reason: z.string().trim().min(1).max(500) });
export type RejectRequest = z.infer<typeof RejectRequestSchema>;

/** GET /api/approvals (approver inbox, userflow 10). */
export const ApprovalsInboxSchema = z.object({
  pending: z.array(
    z.object({
      cycleId: z.string(),
      proposalId: z.string(),
      label: z.string(),
      total: DecimalString,
      flagCount: z.number().int(),
      approvals: z.object({ have: z.number().int(), need: z.number().int() }),
      youApproved: z.boolean(),
      createdAt: IsoTime,
    }),
  ),
});
export type ApprovalsInbox = z.infer<typeof ApprovalsInboxSchema>;

// ---------------------------------------------------------------------------------------------
// Overview, activity, infrastructure (userflow 7, 12)

export const ActivityEntrySchema = z.object({
  id: z.string(),
  at: IsoTime,
  actor: PartyRefSchema.nullable(),
  /** e.g. "mandate.sealed", "cycle.proposed", "proposal.approved", "payment.paid", "grant.closed" */
  kind: z.string(),
  /** One plain-English line, e.g. "Approver 1 approved September 2026 (1 of 2)". */
  text: z.string(),
  link: z.string().nullable(),
  seeded: z.boolean(),
});
export type ActivityEntry = z.infer<typeof ActivityEntrySchema>;

/** GET /api/activity?limit= */
export const ActivityResponseSchema = z.object({ entries: z.array(ActivityEntrySchema) });
export type ActivityResponse = z.infer<typeof ActivityResponseSchema>;

/** GET /api/overview (treasurer, approver). */
export const OverviewResponseSchema = z.object({
  balance: DecimalString.nullable(),
  assetSymbol: z.string(),
  nextCycle: z.object({ cycleId: z.string(), label: z.string(), at: IsoTime }).nullable(),
  /** Expected next total if known (fixed amount or last cycle), for the "Add funds" warning. */
  expectedNextTotal: DecimalString.nullable(),
  fundsWarning: z.object({ balance: DecimalString, required: DecimalString }).nullable(),
  mandate: MandateViewSchema.nullable(),
  pendingApprovals: z.number().int(),
  recentCycles: z.array(CycleSummarySchema),
  recentActivity: z.array(ActivityEntrySchema),
});
export type OverviewResponse = z.infer<typeof OverviewResponseSchema>;

/** GET /api/infrastructure (LocalNet; MainNet returns nodes: []). */
export const InfrastructureResponseSchema = z.object({
  treasuryParty: z.string(),
  hostingThreshold: z.number().int(),
  nodes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      operator: z.string(),
      online: z.boolean(),
      hostsTreasury: z.boolean(),
    }),
  ),
  /** e.g. "Still running on 2 of 3 nodes", or "Below threshold: 1 of 3 nodes online". */
  summary: z.string(),
});
export type InfrastructureResponse = z.infer<typeof InfrastructureResponseSchema>;

/** GET /api/tx/:updateId (LocalNet in-app transaction detail, P3). */
export const TxDetailSchema = z.object({
  updateId: z.string(),
  recordTime: IsoTime,
  /** Only the parts the viewer may see: a holder sees only their own payment. */
  payments: z.array(
    z.object({
      holder: PartyRefSchema,
      amount: DecimalString,
      status: z.string(),
      cycleLabel: z.string(),
    }),
  ),
});
export type TxDetail = z.infer<typeof TxDetailSchema>;

// ---------------------------------------------------------------------------------------------
// Holder (userflow 6). Only the signed-in holder's own data.

/** GET /api/me/position (holder). */
export const HolderPositionSchema = z.object({
  orgName: z.string(),
  assetSymbol: z.string(),
  units: z.number().int(),
  sharePct: DecimalString,
  totalReceived: DecimalString,
  nextPaymentDate: IsoDate.nullable(),
  autoReceive: z.boolean().nullable(),
  /** MainNet: the Grofty party payouts go to, or null before the holder connects. Absent on LocalNet. */
  mainnetWallet: z.object({ partyId: z.string() }).nullable().optional(),
  /** Unit tranches waiting for "Accept units". */
  pendingUnits: z.array(
    z.object({ unitId: z.string(), units: z.number().int(), effectiveDate: IsoDate }),
  ),
  payments: z.array(
    z.object({
      paymentId: z.string(),
      cycleLabel: z.string(),
      amount: DecimalString,
      /** `pending`: authorized, the transfer has not been confirmed yet (P4). */
      status: z.enum(['paid', 'awaiting-acceptance', 'pending']),
      at: IsoTime,
      link: TxLinkSchema.nullable(),
      seeded: z.boolean(),
    }),
  ),
});
export type HolderPosition = z.infer<typeof HolderPositionSchema>;
// POST /api/me/units/:unitId/accept → HolderPosition
// POST /api/me/auto-receive → HolderPosition (LocalNet: creates the preapproval; MainNet: verifies it)
// POST /api/me/payments/:paymentId/accept → HolderPosition (accept a pending transfer)
