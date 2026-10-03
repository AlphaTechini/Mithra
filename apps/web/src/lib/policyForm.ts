/**
 * The policy form: strings the treasurer types, and their conversion to the contract's
 * `PolicyFields`. This only checks that input is well formed (a number is a number); the server
 * recomputes the summary and decides whether the policy is acceptable.
 */
import { DecimalString, type PolicyFields } from '@mithra/shared';

export interface PolicyForm {
  cap: string;
  approvalThreshold: string;
  scheduleCron: string;
  scheduleTimezone: string;
  recordDateRule: PolicyFields['recordDateRule'];
  fixedAmount: string;
  deviationPct: string;
  trailingCycles: string;
  unitChangePct: string;
  unitChangeWindowDays: string;
  feeBuffer: string;
}

export type PolicyFormErrors = Partial<Record<keyof PolicyForm, string>>;

export const COMMON_SCHEDULES: readonly { label: string; cron: string }[] = [
  { label: 'Monthly on the 1st at 09:00', cron: '0 9 1 * *' },
  { label: 'Monthly on the 15th at 09:00', cron: '0 9 15 * *' },
  { label: 'Quarterly on the 1st at 09:00', cron: '0 9 1 1,4,7,10 *' },
  { label: 'Weekly on Mondays at 09:00', cron: '0 9 * * 1' },
];

export const RECORD_DATE_RULES: readonly {
  value: PolicyFields['recordDateRule'];
  label: string;
}[] = [
  { value: 'last_day_of_previous_month', label: 'Last day of the previous month' },
  { value: 'day_before_payment', label: 'The day before payment' },
];

export function toForm(fields: PolicyFields): PolicyForm {
  return {
    cap: fields.cap,
    approvalThreshold: String(fields.approvalThreshold),
    scheduleCron: fields.scheduleCron,
    scheduleTimezone: fields.scheduleTimezone,
    recordDateRule: fields.recordDateRule,
    fixedAmount: fields.fixedAmount ?? '',
    deviationPct: fields.deviationPct,
    trailingCycles: String(fields.trailingCycles),
    unitChangePct: fields.unitChangePct,
    unitChangeWindowDays: String(fields.unitChangeWindowDays),
    feeBuffer: fields.feeBuffer,
  };
}

const POSITIVE_INT = /^[1-9]\d{0,5}$/;
/** A decimal string above zero. A leading minus is never accepted ("-5" has a digit 1 to 9 in it). */
export const POSITIVE_DECIMAL = (v: string): boolean =>
  DecimalString.safeParse(v).success && !v.startsWith('-') && /[1-9]/.test(v);
const NON_NEGATIVE_DECIMAL = (v: string): boolean =>
  DecimalString.safeParse(v).success && !v.startsWith('-');

/**
 * Converts the form to `PolicyFields`, or returns what is wrong, field by field. `approvers`
 * (party ids) come from the draft and are not edited here.
 */
export function parseForm(
  form: PolicyForm,
  approvers: readonly string[],
): { fields: PolicyFields; errors: null } | { fields: null; errors: PolicyFormErrors } {
  const errors: PolicyFormErrors = {};
  const cap = form.cap.trim();
  const fixed = form.fixedAmount.trim();
  const deviation = form.deviationPct.trim();
  const unitChange = form.unitChangePct.trim();
  const buffer = form.feeBuffer.trim();
  const threshold = form.approvalThreshold.trim();
  const trailing = form.trailingCycles.trim();
  const windowDays = form.unitChangeWindowDays.trim();
  const cron = form.scheduleCron.trim();
  const zone = form.scheduleTimezone.trim();

  if (!POSITIVE_DECIMAL(cap)) errors.cap = 'Enter the cap as a number above zero, like 5000.';
  if (!POSITIVE_INT.test(threshold) || Number(threshold) > Math.max(approvers.length, 1)) {
    errors.approvalThreshold = `Choose a whole number from 1 to ${Math.max(approvers.length, 1)}.`;
  }
  if (cron.split(/\s+/).length !== 5) {
    errors.scheduleCron = 'A schedule has five parts, like 0 9 1 * * (09:00 on the 1st).';
  }
  if (zone === '') errors.scheduleTimezone = 'Enter a time zone, like UTC.';
  if (fixed !== '' && !POSITIVE_DECIMAL(fixed)) {
    errors.fixedAmount = 'Leave empty, or enter an amount above zero.';
  }
  if (!NON_NEGATIVE_DECIMAL(deviation)) errors.deviationPct = 'Enter a percentage, like 50.';
  if (!POSITIVE_INT.test(trailing)) errors.trailingCycles = 'Enter a whole number, like 3.';
  if (!NON_NEGATIVE_DECIMAL(unitChange)) errors.unitChangePct = 'Enter a percentage, like 100.';
  if (!POSITIVE_INT.test(windowDays))
    errors.unitChangeWindowDays = 'Enter a whole number of days, like 3.';
  if (!NON_NEGATIVE_DECIMAL(buffer)) errors.feeBuffer = 'Enter an amount, like 5. Zero is allowed.';

  if (Object.keys(errors).length > 0) return { fields: null, errors };
  return {
    errors: null,
    fields: {
      cap,
      approvers: [...approvers],
      approvalThreshold: Number(threshold),
      scheduleCron: cron,
      scheduleTimezone: zone,
      recordDateRule: form.recordDateRule,
      fixedAmount: fixed === '' ? null : fixed,
      deviationPct: deviation,
      trailingCycles: Number(trailing),
      unitChangePct: unitChange,
      unitChangeWindowDays: Number(windowDays),
      feeBuffer: buffer,
    },
  };
}

/** Maps a mandate's terms to editable fields, for "Edit and re-seal". Null if a rule is unknown. */
export function fieldsFromTerms(terms: {
  cap: string;
  approvers: readonly { partyId: string }[];
  approvalThreshold: number;
  scheduleCron: string;
  scheduleTimezone: string;
  recordDateRule: string;
  fixedAmount: string | null;
  deviationPct: string;
  trailingCycles: number;
  unitChangePct: string;
  unitChangeWindowDays: number;
  feeBuffer: string;
}): PolicyFields | null {
  const rule = RECORD_DATE_RULES.find((r) => r.value === terms.recordDateRule);
  if (!rule) return null;
  return {
    cap: terms.cap,
    approvers: terms.approvers.map((a) => a.partyId),
    approvalThreshold: terms.approvalThreshold,
    scheduleCron: terms.scheduleCron,
    scheduleTimezone: terms.scheduleTimezone,
    recordDateRule: rule.value,
    fixedAmount: terms.fixedAmount,
    deviationPct: terms.deviationPct,
    trailingCycles: terms.trailingCycles,
    unitChangePct: terms.unitChangePct,
    unitChangeWindowDays: terms.unitChangeWindowDays,
    feeBuffer: terms.feeBuffer,
  };
}
