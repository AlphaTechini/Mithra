import { describe, expect, it } from 'vitest';
import { PolicyFieldsSchema, RunCycleRequestSchema, TxLinkSchema } from './treasury';

const policy = {
  cap: '5000',
  approvers: ['approver-1', 'approver-2'],
  approvalThreshold: 2,
  scheduleCron: '0 9 1 * *',
  scheduleTimezone: 'UTC',
  recordDateRule: 'last_day_of_previous_month',
  fixedAmount: null,
  deviationPct: '50',
  trailingCycles: 3,
  unitChangePct: '25',
  unitChangeWindowDays: 30,
  feeBuffer: '1',
} as const;

const AMOUNT_FIELDS = ['cap', 'fixedAmount', 'deviationPct', 'unitChangePct', 'feeBuffer'] as const;

describe('PolicyFieldsSchema', () => {
  it('accepts a valid policy, zero amounts and a fixed amount', () => {
    expect(PolicyFieldsSchema.safeParse(policy).success).toBe(true);
    expect(
      PolicyFieldsSchema.safeParse({
        ...policy,
        cap: '0',
        deviationPct: '0',
        unitChangePct: '0',
        feeBuffer: '0',
        fixedAmount: '120.5',
      }).success,
    ).toBe(true);
  });

  it.each(AMOUNT_FIELDS)('rejects a negative %s', (field) => {
    const result = PolicyFieldsSchema.safeParse({ ...policy, [field]: '-1' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual([field]);
  });

  it('rejects a negative fraction as well', () => {
    expect(PolicyFieldsSchema.safeParse({ ...policy, cap: '-0.0000000001' }).success).toBe(false);
  });
});

describe('RunCycleRequestSchema', () => {
  it('accepts no total, a zero total and a positive total', () => {
    expect(RunCycleRequestSchema.safeParse({}).success).toBe(true);
    expect(RunCycleRequestSchema.safeParse({ total: '0' }).success).toBe(true);
    expect(RunCycleRequestSchema.safeParse({ total: '1200.50', cycleId: '2026-09' }).success).toBe(
      true,
    );
  });

  it('rejects a negative total', () => {
    expect(RunCycleRequestSchema.safeParse({ total: '-1200' }).success).toBe(false);
    expect(RunCycleRequestSchema.safeParse({ total: '-0.5', cycleId: '2026-09' }).success).toBe(
      false,
    );
  });
});

describe('TxLinkSchema', () => {
  it('accepts an in-app link and an http(s) explorer link', () => {
    expect(
      TxLinkSchema.safeParse({ updateId: 'u1', href: '/holder/tx/u1', external: false }).success,
    ).toBe(true);
    expect(
      TxLinkSchema.safeParse({
        updateId: 'u1',
        href: 'https://explorer.example/tx/u1',
        external: true,
      }).success,
    ).toBe(true);
    expect(
      TxLinkSchema.safeParse({
        updateId: 'u1',
        href: 'http://localhost:8080/tx/u1',
        external: true,
      }).success,
    ).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,x',
    'ftp://explorer.example/u1',
    '/relative',
    '',
  ])('rejects %j as an external link', (href) => {
    expect(TxLinkSchema.safeParse({ updateId: 'u1', href, external: true }).success).toBe(false);
  });
});
