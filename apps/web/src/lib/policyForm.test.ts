import { describe, expect, it } from 'vitest';
import { POSITIVE_DECIMAL, parseForm, type PolicyForm } from './policyForm';

const FORM: PolicyForm = {
  cap: '5000',
  approvalThreshold: '2',
  scheduleCron: '0 9 1 * *',
  scheduleTimezone: 'UTC',
  recordDateRule: 'last_day_of_previous_month',
  fixedAmount: '',
  deviationPct: '50',
  trailingCycles: '3',
  unitChangePct: '100',
  unitChangeWindowDays: '3',
  feeBuffer: '5',
};
const APPROVERS = ['a::1', 'b::2', 'c::3'];

describe('POSITIVE_DECIMAL', () => {
  it.each(['1', '0.5', '1200.50', '0.0000000001', '007'])('accepts %s', (v) => {
    expect(POSITIVE_DECIMAL(v)).toBe(true);
  });

  it.each(['0', '0.00', '', 'abc', '-5', '-0.5', '-1200.50', '1e3'])('rejects %j', (v) => {
    expect(POSITIVE_DECIMAL(v)).toBe(false);
  });
});

describe('parseForm', () => {
  it('rejects a negative cap and a negative fixed amount with the field own error', () => {
    const result = parseForm({ ...FORM, cap: '-5000', fixedAmount: '-1200' }, APPROVERS);
    expect(result.fields).toBeNull();
    expect(result.errors).toMatchObject({
      cap: 'Enter the cap as a number above zero, like 5000.',
      fixedAmount: 'Leave empty, or enter an amount above zero.',
    });
  });

  it('accepts a positive cap and an empty fixed amount', () => {
    const result = parseForm(FORM, APPROVERS);
    expect(result.errors).toBeNull();
    expect(result.fields).toMatchObject({ cap: '5000', fixedAmount: null });
  });
});
