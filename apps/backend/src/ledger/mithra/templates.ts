import { z } from 'zod';
import { LfDate, LfDecimal, LfInt, LfTime, lfOptional, lfTextMap } from '../codec';

/** Entities (`Module:Entity`) of every Mithra template, the source for ids and decoding. */
export const MITHRA_TEMPLATE_ENTITIES = {
  TreasuryCharter: 'Mithra.Charter:TreasuryCharter',
  Organization: 'Mithra.Org:Organization',
  UnitRegister: 'Mithra.Units:UnitRegister',
  FundUnit: 'Mithra.Units:FundUnit',
  MandateSealRequest: 'Mithra.Mandate:MandateSealRequest',
  Mandate: 'Mithra.Mandate:Mandate',
  Proposal: 'Mithra.Proposal:Proposal',
  Approval: 'Mithra.Proposal:Approval',
  DecisionRecord: 'Mithra.Decision:DecisionRecord',
  DistributionOutcome: 'Mithra.Decision:DistributionOutcome',
  Payment: 'Mithra.Payment:Payment',
  AuditRequest: 'Mithra.Audit:AuditRequest',
  AccessGrant: 'Mithra.Audit:AccessGrant',
  SharedRecord: 'Mithra.Audit:SharedRecord',
  AccessClosed: 'Mithra.Audit:AccessClosed',
  AccessDenied: 'Mithra.Audit:AccessDenied',
  CharterProposal: 'Mithra.Governance:CharterProposal',
  MandateChangeProposal: 'Mithra.Governance:MandateChangeProposal',
} as const;

export type MithraTemplateName = keyof typeof MITHRA_TEMPLATE_ENTITIES;

export type MithraTemplateIds = { readonly [K in MithraTemplateName]: string };

/** Template ids for requests, built from the package reference: `#mithra-v1:Mithra.Org:Organization`. */
export function mithraTemplateIds(pkg: string): MithraTemplateIds {
  const ids = {} as { -readonly [K in MithraTemplateName]: string };
  for (const name of Object.keys(MITHRA_TEMPLATE_ENTITIES) as MithraTemplateName[]) {
    ids[name] = `${pkg}:${MITHRA_TEMPLATE_ENTITIES[name]}`;
  }
  return ids;
}

const Party = z.string().min(1);
const ContractId = z.string().min(1);

// Nested data types (Mithra.Types and friends)

export const InstrumentIdSchema = z.object({ admin: Party, id: z.string() });
export type InstrumentId = z.infer<typeof InstrumentIdSchema>;

export const VerdictSchema = z.enum(['AutoExecute', 'NeedsApproval']);
export type Verdict = z.infer<typeof VerdictSchema>;

export const TriggerSchema = z.enum(['TriggerSchedule', 'TriggerPrompt', 'TriggerManual']);
export type Trigger = z.infer<typeof TriggerSchema>;

/** `PendingExternal`: authorized on this ledger, the money moves on MainNet in Grofty (M10). */
export const PaymentStatusSchema = z.enum(['Paid', 'AwaitingAcceptance', 'PendingExternal']);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

export const OutcomeKindSchema = z.enum(['Executed', 'Rejected', 'Cancelled']);
export type OutcomeKind = z.infer<typeof OutcomeKindSchema>;

export const FingerprintSchema = z.object({ label: z.string(), sha256: z.string() });
export type Fingerprint = z.infer<typeof FingerprintSchema>;

export const CheckResultSchema = z.object({
  /** "cap", "balance", "non_holder", "duplicate_cycle", "deviation", "unit_spike", "prompt_amount", "ai_advisory" */
  code: z.string(),
  label: z.string(),
  passed: z.boolean(),
  /** A failed blocking check forces NeedsApproval. */
  blocking: z.boolean(),
  actual: z.string(),
  limit: z.string(),
  /** "deterministic" or "ai" */
  source: z.string(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const PayoutSchema = z.object({ holder: Party, units: LfInt, amount: LfDecimal });
export type Payout = z.infer<typeof PayoutSchema>;

export const UnitChangeSchema = z.object({
  holder: Party,
  delta: LfInt,
  effectiveDate: LfDate,
  recordedAt: LfTime,
  seeded: z.boolean(),
});
export type UnitChange = z.infer<typeof UnitChangeSchema>;

export const MandateTermsSchema = z.object({
  cap: LfDecimal,
  approvers: z.array(Party),
  approvalThreshold: LfInt,
  asset: InstrumentIdSchema,
  scheduleCron: z.string(),
  scheduleTimezone: z.string(),
  recordDateRule: z.string(),
  fixedAmount: lfOptional(LfDecimal),
  deviationPct: LfDecimal,
  trailingCycles: LfInt,
  unitChangePct: LfDecimal,
  unitChangeWindowDays: LfInt,
  feeBuffer: LfDecimal,
});
export type MandateTerms = z.infer<typeof MandateTermsSchema>;

export const ApprovalEntrySchema = z.object({ approver: Party, at: LfTime, note: z.string() });
export type ApprovalEntry = z.infer<typeof ApprovalEntrySchema>;

export const PaymentRefSchema = z.object({
  holder: Party,
  amount: LfDecimal,
  paymentCid: ContractId,
  status: PaymentStatusSchema,
  transferInstructionCid: lfOptional(ContractId),
});
export type PaymentRef = z.infer<typeof PaymentRefSchema>;

/** Splice `AnyValue`: a variant such as `{ tag: "AV_ContractId", value: "00..." }`. Kept opaque. */
export const AnyValueSchema = z.looseObject({ tag: z.string(), value: z.unknown() });
export type AnyValue = z.infer<typeof AnyValueSchema>;

/** Splice `ExtraArgs`: choice context and metadata handed to a registry's choice. */
export const ExtraArgsSchema = z.object({
  context: z.object({ values: lfTextMap(AnyValueSchema) }),
  meta: z.object({ values: lfTextMap(z.string()) }),
});
export type ExtraArgs = z.infer<typeof ExtraArgsSchema>;

export const TransferLegSchema = z.object({
  holder: Party,
  factoryCid: ContractId,
  extraArgs: ExtraArgsSchema,
});
export type TransferLeg = z.infer<typeof TransferLegSchema>;

export const ScopeItemSchema = z.object({
  recordId: z.string(),
  kind: z.string(),
  reason: z.string(),
});
export type ScopeItem = z.infer<typeof ScopeItemSchema>;

// Template payloads

export const TreasuryCharterSchema = z.object({
  treasury: Party,
  treasurer: Party,
  agent: Party,
  operator: Party,
});
export type TreasuryCharter = z.infer<typeof TreasuryCharterSchema>;

export const OrganizationSchema = z.object({
  treasury: Party,
  treasurer: Party,
  agent: Party,
  operator: Party,
  name: z.string(),
  asset: InstrumentIdSchema,
  approvers: z.array(Party),
  approvalThreshold: LfInt,
  /** 0 until the first Mandate is sealed. */
  mandateVersion: LfInt,
});
export type Organization = z.infer<typeof OrganizationSchema>;

export const UnitRegisterSchema = z.object({
  treasury: Party,
  treasurer: Party,
  agent: Party,
  changes: z.array(UnitChangeSchema),
});
export type UnitRegister = z.infer<typeof UnitRegisterSchema>;

export const FundUnitSchema = z.object({
  treasury: Party,
  holder: Party,
  orgName: z.string(),
  units: LfInt,
  effectiveDate: LfDate,
  issuedAt: LfTime,
  accepted: z.boolean(),
  seeded: z.boolean(),
});
export type FundUnit = z.infer<typeof FundUnitSchema>;

export const MandateSealRequestSchema = z.object({
  treasury: Party,
  treasurer: Party,
  agent: Party,
  terms: MandateTermsSchema,
  agentExecutes: z.boolean(),
  summary: z.string(),
  summaryFingerprint: z.string(),
  requestedAt: LfTime,
});
export type MandateSealRequest = z.infer<typeof MandateSealRequestSchema>;

/** The newest attempt number proposed for a cycle (`Mandate.cycleAttempts`). */
export const CycleAttemptSchema = z.object({ cycleId: z.string(), attempt: LfInt });
export type CycleAttempt = z.infer<typeof CycleAttemptSchema>;

export const MandateSchema = z.object({
  treasury: Party,
  treasurer: Party,
  agent: Party,
  version: LfInt,
  terms: MandateTermsSchema,
  agentExecutes: z.boolean(),
  executedCycles: z.array(z.string()),
  /** The newest attempt number proposed per cycle: the next proposal for a cycle must be one more. */
  cycleAttempts: z.array(CycleAttemptSchema),
  sealedAt: LfTime,
  summaryFingerprint: z.string(),
});
export type Mandate = z.infer<typeof MandateSchema>;

export const ProposalSchema = z.object({
  treasury: Party,
  treasurer: Party,
  agent: Party,
  proposalId: z.string(),
  cycleId: z.string(),
  cycleLabel: z.string(),
  recordDate: LfDate,
  total: LfDecimal,
  payouts: z.array(PayoutSchema),
  verdict: VerdictSchema,
  approvers: z.array(Party),
  approvalThreshold: LfInt,
  approvals: z.array(ApprovalEntrySchema),
  decisionRecordCid: ContractId,
  decisionRecordId: z.string(),
  mandateVersion: LfInt,
  createdAt: LfTime,
  seeded: z.boolean(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const ApprovalSchema = z.object({
  approver: Party,
  treasury: Party,
  treasurer: Party,
  agent: Party,
  proposalId: z.string(),
  cycleId: z.string(),
  decisionRecordId: z.string(),
  at: LfTime,
  note: z.string(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const DecisionRecordSchema = z.object({
  recordId: z.string(),
  treasury: Party,
  treasurer: Party,
  agent: Party,
  approvers: z.array(Party),
  cycleId: z.string(),
  cycleLabel: z.string(),
  trigger: TriggerSchema,
  triggerDetail: z.string(),
  recordDate: LfDate,
  total: LfDecimal,
  payouts: z.array(PayoutSchema),
  inputFingerprints: z.array(FingerprintSchema),
  checks: z.array(CheckResultSchema),
  memo: z.string(),
  memoSource: z.string(),
  modelFingerprints: z.array(FingerprintSchema),
  verdict: VerdictSchema,
  mandateVersion: LfInt,
  cap: LfDecimal,
  createdAt: LfTime,
  seeded: z.boolean(),
});
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

export const DistributionOutcomeSchema = z.object({
  recordId: z.string(),
  treasury: Party,
  treasurer: Party,
  agent: Party,
  approvers: z.array(Party),
  decisionRecordId: z.string(),
  cycleId: z.string(),
  cycleLabel: z.string(),
  kind: OutcomeKindSchema,
  approvals: z.array(ApprovalEntrySchema),
  payments: z.array(PaymentRefSchema),
  actor: Party,
  reason: lfOptional(z.string()),
  at: LfTime,
  seeded: z.boolean(),
});
export type DistributionOutcome = z.infer<typeof DistributionOutcomeSchema>;

export const PaymentSchema = z.object({
  treasury: Party,
  agent: Party,
  holder: Party,
  cycleId: z.string(),
  cycleLabel: z.string(),
  units: LfInt,
  amount: LfDecimal,
  status: PaymentStatusSchema,
  transferInstructionCid: lfOptional(ContractId),
  executedAt: LfTime,
  seeded: z.boolean(),
  /** MainNet payouts: the payee's MainNet party id, and the MainNet update id once recorded. */
  externalReceiver: lfOptional(z.string()),
  externalTxRef: lfOptional(z.string()),
});
export type Payment = z.infer<typeof PaymentSchema>;

export const AuditRequestSchema = z.object({
  auditor: Party,
  treasury: Party,
  treasurer: Party,
  agent: Party,
  requestId: z.string(),
  question: z.string(),
  scope: z.array(ScopeItemSchema),
  excluded: z.string(),
  requestedAt: LfTime,
});
export type AuditRequest = z.infer<typeof AuditRequestSchema>;

/** A copy of a shared record, as the ledger encodes the `Evidence` variant. */
export const EvidenceSchema = z.discriminatedUnion('tag', [
  z.object({ tag: z.literal('EvDecision'), value: DecisionRecordSchema }),
  z.object({ tag: z.literal('EvOutcome'), value: DistributionOutcomeSchema }),
]);
export type Evidence = z.infer<typeof EvidenceSchema>;

/** A reference to a record to share, as the ledger encodes the `EvidenceRef` variant. */
export const EvidenceRefSchema = z.discriminatedUnion('tag', [
  z.object({ tag: z.literal('RefDecision'), value: ContractId }),
  z.object({ tag: z.literal('RefOutcome'), value: ContractId }),
]);
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const SharedRecordSchema = z.object({
  treasury: Party,
  treasurer: Party,
  agent: Party,
  auditor: Party,
  grantId: z.string(),
  recordId: z.string(),
  evidence: EvidenceSchema,
  sharedAt: LfTime,
  expiresAt: LfTime,
});
export type SharedRecord = z.infer<typeof SharedRecordSchema>;

export const AccessGrantSchema = z.object({
  treasury: Party,
  treasurer: Party,
  agent: Party,
  auditor: Party,
  grantId: z.string(),
  requestId: z.string(),
  question: z.string(),
  recordIds: z.array(z.string()),
  sharedCids: z.array(ContractId),
  grantedAt: LfTime,
  expiresAt: LfTime,
});
export type AccessGrant = z.infer<typeof AccessGrantSchema>;

export const AccessClosedSchema = z.object({
  treasury: Party,
  treasurer: Party,
  agent: Party,
  auditor: Party,
  grantId: z.string(),
  requestId: z.string(),
  closedAt: LfTime,
  closedBy: Party,
  reason: z.string(),
});
export type AccessClosed = z.infer<typeof AccessClosedSchema>;

export const AccessDeniedSchema = z.object({
  treasury: Party,
  treasurer: Party,
  agent: Party,
  auditor: Party,
  requestId: z.string(),
  reason: z.string(),
  at: LfTime,
});
export type AccessDenied = z.infer<typeof AccessDeniedSchema>;

export const CharterProposalSchema = z.object({
  governanceParty: Party,
  proposer: Party,
  treasurer: Party,
  agent: Party,
  operator: Party,
});
export type CharterProposal = z.infer<typeof CharterProposalSchema>;

export const MandateChangeProposalSchema = z.object({
  governanceParty: Party,
  proposer: Party,
  orgCid: ContractId,
  sealRequestCid: ContractId,
  currentMandateCid: lfOptional(ContractId),
  description: z.string(),
});
export type MandateChangeProposal = z.infer<typeof MandateChangeProposalSchema>;

/** Payload schema of every Mithra template, by name. */
export const MITHRA_PAYLOAD_SCHEMAS = {
  TreasuryCharter: TreasuryCharterSchema,
  Organization: OrganizationSchema,
  UnitRegister: UnitRegisterSchema,
  FundUnit: FundUnitSchema,
  MandateSealRequest: MandateSealRequestSchema,
  Mandate: MandateSchema,
  Proposal: ProposalSchema,
  Approval: ApprovalSchema,
  DecisionRecord: DecisionRecordSchema,
  DistributionOutcome: DistributionOutcomeSchema,
  Payment: PaymentSchema,
  AuditRequest: AuditRequestSchema,
  AccessGrant: AccessGrantSchema,
  SharedRecord: SharedRecordSchema,
  AccessClosed: AccessClosedSchema,
  AccessDenied: AccessDeniedSchema,
  CharterProposal: CharterProposalSchema,
  MandateChangeProposal: MandateChangeProposalSchema,
} as const satisfies Record<MithraTemplateName, z.ZodType>;

export type MithraPayloads = {
  [K in MithraTemplateName]: z.output<(typeof MITHRA_PAYLOAD_SCHEMAS)[K]>;
};

/** A decoded contract: id, payload and creation time. */
export interface Contract<T> {
  contractId: string;
  payload: T;
  createdAt: string;
}
