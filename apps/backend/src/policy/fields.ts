import {
  PolicyFieldsSchema,
  toDecimal,
  type MandateTermsView,
  type PolicyFields,
} from '@mithra/shared';
import { assertSchedule } from '../cycle/period';
import { ApiError } from '../http/errors';
import type { InstrumentId, MandateTerms } from '../ledger';
import { describePolicy, type PartyNameSource } from './describe';
import type { PartyRef } from '@mithra/shared';

/** The editable policy fields of sealed terms (the draft built from the current Mandate). */
export function fieldsFromTerms(terms: MandateTerms): PolicyFields {
  return PolicyFieldsSchema.parse({
    cap: terms.cap,
    approvers: terms.approvers,
    approvalThreshold: terms.approvalThreshold,
    scheduleCron: terms.scheduleCron,
    scheduleTimezone: terms.scheduleTimezone,
    recordDateRule:
      terms.recordDateRule === 'day_before_payment'
        ? 'day_before_payment'
        : 'last_day_of_previous_month',
    fixedAmount: terms.fixedAmount,
    deviationPct: terms.deviationPct,
    trailingCycles: Math.max(terms.trailingCycles, 1),
    unitChangePct: terms.unitChangePct,
    unitChangeWindowDays: Math.max(terms.unitChangeWindowDays, 1),
    feeBuffer: terms.feeBuffer,
  });
}

/** Mandate terms for the ledger from policy fields and the organization's asset. */
export function termsFromFields(fields: PolicyFields, asset: InstrumentId): MandateTerms {
  return {
    cap: fields.cap,
    approvers: fields.approvers,
    approvalThreshold: fields.approvalThreshold,
    asset,
    scheduleCron: fields.scheduleCron,
    scheduleTimezone: fields.scheduleTimezone,
    recordDateRule: fields.recordDateRule,
    fixedAmount: fields.fixedAmount,
    deviationPct: fields.deviationPct,
    trailingCycles: fields.trailingCycles,
    unitChangePct: fields.unitChangePct,
    unitChangeWindowDays: fields.unitChangeWindowDays,
    feeBuffer: fields.feeBuffer,
  };
}

/**
 * Problems that would make the ledger refuse these terms (Daml `termsValid`) or that make no
 * sense, each written to say what to change. Empty when the fields can be sealed.
 */
export function policyProblems(fields: PolicyFields, agentParty: string): string[] {
  const problems: string[] = [];
  const distinct = new Set(fields.approvers);
  if (distinct.size !== fields.approvers.length) {
    problems.push('Each approver can be listed once. Remove the duplicate.');
  }
  if (fields.approvalThreshold > distinct.size) {
    problems.push(
      `The threshold is ${fields.approvalThreshold} but there ${distinct.size === 1 ? 'is 1 approver' : `are ${distinct.size} approvers`}. Lower the threshold or add approvers.`,
    );
  }
  if (fields.approvers.includes(agentParty)) {
    problems.push('The agent cannot be an approver. Choose a person.');
  }
  const negative = (value: string): boolean => toDecimal(value).isNegative();
  if (negative(fields.cap)) problems.push('The auto-execute cap cannot be negative.');
  if (fields.fixedAmount !== null && !toDecimal(fields.fixedAmount).gt(0)) {
    problems.push('The fixed amount must be more than zero, or leave it empty.');
  }
  if (negative(fields.deviationPct)) problems.push('The deviation threshold cannot be negative.');
  if (negative(fields.unitChangePct))
    problems.push('The unit-change threshold cannot be negative.');
  if (negative(fields.feeBuffer)) problems.push('The fee buffer cannot be negative.');
  try {
    assertSchedule(fields.scheduleCron, fields.scheduleTimezone);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : 'The schedule is not valid.');
  }
  return problems;
}

/** Throws a 422 `invalid_policy` listing every problem, or returns when the fields are valid. */
export function assertPolicyValid(fields: PolicyFields, agentParty: string): void {
  const problems = policyProblems(fields, agentParty);
  if (problems.length > 0) {
    throw new ApiError(422, 'invalid_policy', problems.join(' '));
  }
}

/** The terms as the API shows them (Mandate view): approvers named, schedule and record date in words. */
export function termsView(
  terms: MandateTerms,
  approvers: PartyRef[],
  names: PartyNameSource,
  assetSymbol: string,
): MandateTermsView {
  const description = describePolicy(fieldsFromTerms(terms), names, assetSymbol);
  return {
    cap: terms.cap,
    approvers,
    approvalThreshold: terms.approvalThreshold,
    assetSymbol,
    scheduleCron: terms.scheduleCron,
    scheduleTimezone: terms.scheduleTimezone,
    scheduleText: description.scheduleText,
    recordDateRule: terms.recordDateRule,
    recordDateText: description.recordDateText,
    fixedAmount: terms.fixedAmount,
    deviationPct: terms.deviationPct,
    trailingCycles: terms.trailingCycles,
    unitChangePct: terms.unitChangePct,
    unitChangeWindowDays: terms.unitChangeWindowDays,
    feeBuffer: terms.feeBuffer,
  };
}
