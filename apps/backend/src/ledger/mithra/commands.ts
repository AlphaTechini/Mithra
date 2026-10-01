import { z } from 'zod';
import { exerciseResultOf } from '../client';
import {
  encodeDate,
  encodeDecimal,
  encodeInt,
  encodeOptional,
  encodeTime,
  encodeVariant,
  lfTuple2,
} from '../codec';
import type { CreateCommand, ExerciseCommand, Transaction } from '../types';
import type {
  CheckResult,
  ExtraArgs,
  Fingerprint,
  InstrumentId,
  MandateTerms,
  MithraTemplateIds,
  Payout,
  ScopeItem,
  TransferLeg,
  Trigger,
  EvidenceRef,
} from './templates';
import type { MithraTemplateName } from './templates';

// Encoders: application types to Daml-LF JSON. Amounts stay strings, Ints become strings.

function encodeInstrument(i: InstrumentId): Record<string, unknown> {
  return { admin: i.admin, id: i.id };
}

export function encodeMandateTerms(t: MandateTerms): Record<string, unknown> {
  return {
    cap: encodeDecimal(t.cap),
    approvers: t.approvers,
    approvalThreshold: encodeInt(t.approvalThreshold),
    asset: encodeInstrument(t.asset),
    scheduleCron: t.scheduleCron,
    scheduleTimezone: t.scheduleTimezone,
    recordDateRule: t.recordDateRule,
    fixedAmount: encodeOptional(t.fixedAmount, encodeDecimal),
    deviationPct: encodeDecimal(t.deviationPct),
    trailingCycles: encodeInt(t.trailingCycles),
    unitChangePct: encodeDecimal(t.unitChangePct),
    unitChangeWindowDays: encodeInt(t.unitChangeWindowDays),
    feeBuffer: encodeDecimal(t.feeBuffer),
  };
}

function encodePayout(p: Payout): Record<string, unknown> {
  return { holder: p.holder, units: encodeInt(p.units), amount: encodeDecimal(p.amount) };
}

function encodeCheck(c: CheckResult): Record<string, unknown> {
  return {
    code: c.code,
    label: c.label,
    passed: c.passed,
    blocking: c.blocking,
    actual: c.actual,
    limit: c.limit,
    source: c.source,
  };
}

function encodeFingerprint(f: Fingerprint): Record<string, unknown> {
  return { label: f.label, sha256: f.sha256 };
}

export function encodeExtraArgs(e: ExtraArgs): Record<string, unknown> {
  return { context: { values: e.context.values }, meta: { values: e.meta.values } };
}

export function encodeTransferLeg(l: TransferLeg): Record<string, unknown> {
  return { holder: l.holder, factoryCid: l.factoryCid, extraArgs: encodeExtraArgs(l.extraArgs) };
}

function encodeScopeItem(s: ScopeItem): Record<string, unknown> {
  return { recordId: s.recordId, kind: s.kind, reason: s.reason };
}

function encodeEvidenceRef(ref: EvidenceRef): { tag: string; value: string } {
  return encodeVariant(ref.tag, ref.value);
}

/** Everything the agent supplies to `Mandate_Propose`; the Mandate computes the verdict. */
export interface ProposalInput {
  cycleId: string;
  cycleLabel: string;
  /** 1 for the first proposal of a cycle, then 2, 3, ... after a cancel or reject. */
  attempt: number;
  total: string;
  recordDate: string;
  trigger: Trigger;
  triggerDetail: string;
  payouts: Payout[];
  registerCid: string;
  inputFingerprints: Fingerprint[];
  checks: CheckResult[];
  memo: string;
  memoSource: string;
  modelFingerprints: Fingerprint[];
  seeded: boolean;
}

function encodeProposalInput(i: ProposalInput): Record<string, unknown> {
  return {
    cycleId: i.cycleId,
    cycleLabel: i.cycleLabel,
    attempt: encodeInt(i.attempt),
    total: encodeDecimal(i.total),
    recordDate: encodeDate(i.recordDate),
    trigger: i.trigger,
    triggerDetail: i.triggerDetail,
    payouts: i.payouts.map(encodePayout),
    registerCid: i.registerCid,
    inputFingerprints: i.inputFingerprints.map(encodeFingerprint),
    checks: i.checks.map(encodeCheck),
    memo: i.memo,
    memoSource: i.memoSource,
    modelFingerprints: i.modelFingerprints.map(encodeFingerprint),
    seeded: i.seeded,
  };
}

export interface ExecuteInput {
  proposalCid: string;
  legs: TransferLeg[];
  inputHoldingCids: string[];
  /** The transfers must complete before this time. */
  executeBefore: Date | string;
}

function encodeExecute(i: ExecuteInput): Record<string, unknown> {
  return {
    proposalCid: i.proposalCid,
    legs: i.legs.map(encodeTransferLeg),
    inputHoldingCids: i.inputHoldingCids,
    executeBefore: encodeTime(i.executeBefore),
  };
}

/** Builders for every choice and create command of the Mithra model. */
export function createMithraCommands(ids: MithraTemplateIds) {
  const exercise = (
    template: MithraTemplateName,
    contractId: string,
    choice: string,
    choiceArgument: Record<string, unknown> = {},
  ): ExerciseCommand => ({
    ExerciseCommand: { templateId: ids[template], contractId, choice, choiceArgument },
  });
  const create = (
    template: MithraTemplateName,
    createArguments: Record<string, unknown>,
  ): CreateCommand => ({ CreateCommand: { templateId: ids[template], createArguments } });

  return {
    // TreasuryCharter
    createTreasuryCharter(args: {
      treasury: string;
      treasurer: string;
      agent: string;
      operator: string;
    }): CreateCommand {
      return create('TreasuryCharter', { ...args });
    },
    charterCreateOrganization(
      charterCid: string,
      args: { name: string; asset: InstrumentId; approvers: string[]; approvalThreshold: number },
    ): ExerciseCommand {
      return exercise('TreasuryCharter', charterCid, 'Charter_CreateOrganization', {
        name: args.name,
        asset: encodeInstrument(args.asset),
        approvers: args.approvers,
        approvalThreshold: encodeInt(args.approvalThreshold),
      });
    },

    // Organization
    orgIssueUnits(
      orgCid: string,
      args: {
        registerCid: string;
        holder: string;
        units: number;
        effectiveDate: Date | string;
        seeded: boolean;
      },
    ): ExerciseCommand {
      return exercise('Organization', orgCid, 'Org_IssueUnits', {
        registerCid: args.registerCid,
        holder: args.holder,
        units: encodeInt(args.units),
        effectiveDate: encodeDate(args.effectiveDate),
        seeded: args.seeded,
      });
    },
    orgAcceptDeposit(
      orgCid: string,
      args: { instructionCid: string; extraArgs: ExtraArgs },
    ): ExerciseCommand {
      return exercise('Organization', orgCid, 'Org_AcceptDeposit', {
        instructionCid: args.instructionCid,
        extraArgs: encodeExtraArgs(args.extraArgs),
      });
    },
    orgApplySeal(
      orgCid: string,
      args: { sealRequestCid: string; currentMandateCid: string | null },
    ): ExerciseCommand {
      return exercise('Organization', orgCid, 'Org_ApplySeal', {
        sealRequestCid: args.sealRequestCid,
        currentMandateCid: encodeOptional(args.currentMandateCid),
      });
    },
    orgGrantAccess(
      orgCid: string,
      args: { requestCid: string; expiresAt: Date | string; evidence: EvidenceRef[] },
    ): ExerciseCommand {
      return exercise('Organization', orgCid, 'Org_GrantAccess', {
        requestCid: args.requestCid,
        expiresAt: encodeTime(args.expiresAt),
        evidence: args.evidence.map(encodeEvidenceRef),
      });
    },
    orgDenyAccess(orgCid: string, args: { requestCid: string; reason: string }): ExerciseCommand {
      return exercise('Organization', orgCid, 'Org_DenyAccess', { ...args });
    },

    // MandateSealRequest
    createMandateSealRequest(args: {
      treasury: string;
      treasurer: string;
      agent: string;
      terms: MandateTerms;
      agentExecutes: boolean;
      summary: string;
      summaryFingerprint: string;
      requestedAt: Date | string;
    }): CreateCommand {
      return create('MandateSealRequest', {
        treasury: args.treasury,
        treasurer: args.treasurer,
        agent: args.agent,
        terms: encodeMandateTerms(args.terms),
        agentExecutes: args.agentExecutes,
        summary: args.summary,
        summaryFingerprint: args.summaryFingerprint,
        requestedAt: encodeTime(args.requestedAt),
      });
    },
    sealRequestWithdraw(sealRequestCid: string): ExerciseCommand {
      return exercise('MandateSealRequest', sealRequestCid, 'SealRequest_Withdraw');
    },

    // Mandate
    mandatePropose(mandateCid: string, input: ProposalInput): ExerciseCommand {
      return exercise('Mandate', mandateCid, 'Mandate_Propose', {
        input: encodeProposalInput(input),
      });
    },
    mandateAgentExecute(mandateCid: string, input: ExecuteInput): ExerciseCommand {
      return exercise('Mandate', mandateCid, 'Mandate_AgentExecute', encodeExecute(input));
    },
    mandateTreasuryExecute(mandateCid: string, input: ExecuteInput): ExerciseCommand {
      return exercise('Mandate', mandateCid, 'Mandate_TreasuryExecute', encodeExecute(input));
    },

    // Proposal
    proposalApprove(
      proposalCid: string,
      args: { approver: string; note: string },
    ): ExerciseCommand {
      return exercise('Proposal', proposalCid, 'Proposal_Approve', { ...args });
    },
    proposalReject(
      proposalCid: string,
      args: { approver: string; reason: string },
    ): ExerciseCommand {
      return exercise('Proposal', proposalCid, 'Proposal_Reject', { ...args });
    },
    proposalCancel(proposalCid: string): ExerciseCommand {
      return exercise('Proposal', proposalCid, 'Proposal_Cancel');
    },

    // FundUnit, Payment
    fundUnitAccept(fundUnitCid: string): ExerciseCommand {
      return exercise('FundUnit', fundUnitCid, 'FundUnit_Accept');
    },
    paymentMarkAccepted(paymentCid: string): ExerciseCommand {
      return exercise('Payment', paymentCid, 'Payment_MarkAccepted');
    },

    // Audit
    createAuditRequest(args: {
      auditor: string;
      treasury: string;
      treasurer: string;
      agent: string;
      requestId: string;
      question: string;
      scope: ScopeItem[];
      excluded: string;
      requestedAt: Date | string;
    }): CreateCommand {
      return create('AuditRequest', {
        auditor: args.auditor,
        treasury: args.treasury,
        treasurer: args.treasurer,
        agent: args.agent,
        requestId: args.requestId,
        question: args.question,
        scope: args.scope.map(encodeScopeItem),
        excluded: args.excluded,
        requestedAt: encodeTime(args.requestedAt),
      });
    },
    auditRequestWithdraw(auditRequestCid: string): ExerciseCommand {
      return exercise('AuditRequest', auditRequestCid, 'AuditRequest_Withdraw');
    },
    accessGrantCloseExpired(grantCid: string, args: { closer: string }): ExerciseCommand {
      return exercise('AccessGrant', grantCid, 'AccessGrant_CloseExpired', { closer: args.closer });
    },
    accessGrantRevoke(grantCid: string): ExerciseCommand {
      return exercise('AccessGrant', grantCid, 'AccessGrant_Revoke');
    },

    // Governed actions (LocalNet): created by the operator, executed by the Decentralization Manager
    createCharterProposal(args: {
      governanceParty: string;
      proposer: string;
      treasurer: string;
      agent: string;
      operator: string;
    }): CreateCommand {
      return create('CharterProposal', { ...args });
    },
    createMandateChangeProposal(args: {
      governanceParty: string;
      proposer: string;
      orgCid: string;
      sealRequestCid: string;
      currentMandateCid: string | null;
      description: string;
    }): CreateCommand {
      return create('MandateChangeProposal', {
        governanceParty: args.governanceParty,
        proposer: args.proposer,
        orgCid: args.orgCid,
        sealRequestCid: args.sealRequestCid,
        currentMandateCid: encodeOptional(args.currentMandateCid),
        description: args.description,
      });
    },
  };
}

export type MithraCommands = ReturnType<typeof createMithraCommands>;

const Cid = z.string().min(1);

function pair(tx: Transaction, choice: string): { first: string; second: string } {
  const parsed = lfTuple2(Cid, Cid).parse(exerciseResultOf(tx, choice));
  return { first: parsed._1, second: parsed._2 };
}

/**
 * Decoders for choice results. They read the exercise result of the choice from a transaction
 * submitted with shape `LEDGER_EFFECTS`.
 */
export const choiceResults = {
  charterCreateOrganization(tx: Transaction): { orgCid: string; registerCid: string } {
    const { first, second } = pair(tx, 'Charter_CreateOrganization');
    return { orgCid: first, registerCid: second };
  },
  orgIssueUnits(tx: Transaction): { registerCid: string; fundUnitCid: string } {
    const { first, second } = pair(tx, 'Org_IssueUnits');
    return { registerCid: first, fundUnitCid: second };
  },
  orgApplySeal(tx: Transaction): { orgCid: string; mandateCid: string } {
    const { first, second } = pair(tx, 'Org_ApplySeal');
    return { orgCid: first, mandateCid: second };
  },
  orgGrantAccess(tx: Transaction): { grantCid: string } {
    return { grantCid: Cid.parse(exerciseResultOf(tx, 'Org_GrantAccess')) };
  },
  orgDenyAccess(tx: Transaction): { deniedCid: string } {
    return { deniedCid: Cid.parse(exerciseResultOf(tx, 'Org_DenyAccess')) };
  },
  mandatePropose(tx: Transaction): { proposalCid: string; decisionRecordCid: string } {
    const { first, second } = pair(tx, 'Mandate_Propose');
    return { proposalCid: first, decisionRecordCid: second };
  },
  mandateAgentExecute(tx: Transaction): { mandateCid: string; outcomeCid: string } {
    const { first, second } = pair(tx, 'Mandate_AgentExecute');
    return { mandateCid: first, outcomeCid: second };
  },
  mandateTreasuryExecute(tx: Transaction): { mandateCid: string; outcomeCid: string } {
    const { first, second } = pair(tx, 'Mandate_TreasuryExecute');
    return { mandateCid: first, outcomeCid: second };
  },
  proposalApprove(tx: Transaction): { proposalCid: string; approvalCid: string } {
    const { first, second } = pair(tx, 'Proposal_Approve');
    return { proposalCid: first, approvalCid: second };
  },
  proposalReject(tx: Transaction): { outcomeCid: string } {
    return { outcomeCid: Cid.parse(exerciseResultOf(tx, 'Proposal_Reject')) };
  },
  proposalCancel(tx: Transaction): { outcomeCid: string } {
    return { outcomeCid: Cid.parse(exerciseResultOf(tx, 'Proposal_Cancel')) };
  },
  fundUnitAccept(tx: Transaction): { fundUnitCid: string } {
    return { fundUnitCid: Cid.parse(exerciseResultOf(tx, 'FundUnit_Accept')) };
  },
  paymentMarkAccepted(tx: Transaction): { paymentCid: string } {
    return { paymentCid: Cid.parse(exerciseResultOf(tx, 'Payment_MarkAccepted')) };
  },
  accessGrantCloseExpired(tx: Transaction): { closedCid: string } {
    return { closedCid: Cid.parse(exerciseResultOf(tx, 'AccessGrant_CloseExpired')) };
  },
  accessGrantRevoke(tx: Transaction): { closedCid: string } {
    return { closedCid: Cid.parse(exerciseResultOf(tx, 'AccessGrant_Revoke')) };
  },
} as const;
