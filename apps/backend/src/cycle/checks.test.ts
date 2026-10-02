import { describe, expect, it } from 'vitest';
import {
  checkBalance,
  checkCap,
  checkDeviation,
  checkDuplicateCycle,
  checkNonHolder,
  checkPromptAmount,
  checkUnitSpike,
  runChecks,
  selectHistory,
  type CheckInputs,
} from './checks';

const names: Record<string, string> = {
  a: 'Holder A',
  b: 'Holder B',
  c: 'Holder C',
  d: 'Holder D',
};
const nameOf = (p: string): string => names[p] ?? p;

describe('cap', () => {
  it('passes at the cap and fails one unit above it', () => {
    const at = checkCap({ total: '5000.0000000000', cap: '5000.0000000000', symbol: 'CC' });
    expect(at).toMatchObject({
      code: 'cap',
      passed: true,
      blocking: true,
      source: 'deterministic',
      actual: 'Total 5,000 CC vs cap 5,000 CC',
      limit: 'At most 5,000 CC',
    });
    const above = checkCap({ total: '5000.0000000001', cap: '5000.0000000000', symbol: 'CC' });
    expect(above.passed).toBe(false);
    expect(above.actual).toBe('Total 5,000.0000000001 CC vs cap 5,000 CC');
  });
});

describe('balance', () => {
  it('is not blocking and shows the actual values', () => {
    const ok = checkBalance({ total: '1200', feeBuffer: '1', balance: '10000', symbol: 'CC' });
    expect(ok).toMatchObject({
      code: 'balance',
      passed: true,
      blocking: false,
      actual: 'Balance 10,000 CC vs 1,201 CC needed (1,200 CC plus 1 CC fee buffer)',
      limit: 'At least 1,201 CC',
    });
    const short = checkBalance({ total: '1200', feeBuffer: '1', balance: '1200.5', symbol: 'CC' });
    expect(short.passed).toBe(false);
    expect(short.blocking).toBe(false);
  });

  it('MainNet (P5): the server cannot read the wallet, so it says the check happens in Grofty', () => {
    const check = checkBalance({ total: '300', feeBuffer: '1', balance: null, symbol: 'CC' });
    expect(check).toMatchObject({
      code: 'balance',
      passed: true,
      blocking: false,
      actual: 'Checked in Grofty Wallet before signing',
      limit: 'At least 301 CC',
    });
  });

  it('passes with exactly total plus fee buffer', () => {
    expect(
      checkBalance({ total: '300', feeBuffer: '1', balance: '301', symbol: 'CC' }).passed,
    ).toBe(true);
  });
});

describe('non_holder', () => {
  const holdings = [
    { holder: 'a', units: 100 },
    { holder: 'b', units: 300 },
  ];
  it('passes when every payee held units', () => {
    const result = checkNonHolder({
      payouts: [{ holder: 'a' }, { holder: 'b' }],
      holdingsOnRecordDate: holdings,
      recordDate: '2026-09-30',
      nameOf,
    });
    expect(result).toMatchObject({
      code: 'non_holder',
      passed: true,
      blocking: true,
      actual: '2 of 2 payees held units on Sep 30',
    });
  });

  it('says "1 of 1 payee" for a single payee', () => {
    const result = checkNonHolder({
      payouts: [{ holder: 'a' }],
      holdingsOnRecordDate: holdings,
      recordDate: '2026-09-30',
      nameOf,
    });
    expect(result.actual).toBe('1 of 1 payee held units on Sep 30');
  });

  it('fails and names a payee who did not hold units', () => {
    const result = checkNonHolder({
      payouts: [{ holder: 'a' }, { holder: 'd' }],
      holdingsOnRecordDate: holdings,
      recordDate: '2026-09-30',
      nameOf,
    });
    expect(result.passed).toBe(false);
    expect(result.actual).toBe('Holder D did not hold units on Sep 30');
  });
});

describe('duplicate_cycle', () => {
  it('passes when no distribution exists and fails when one was executed', () => {
    expect(checkDuplicateCycle({ cycleId: '2026-09', alreadyExecuted: false })).toMatchObject({
      code: 'duplicate_cycle',
      passed: true,
      blocking: true,
      actual: 'No distribution exists for September 2026',
    });
    const dup = checkDuplicateCycle({ cycleId: '2026-09', alreadyExecuted: true });
    expect(dup.passed).toBe(false);
    expect(dup.actual).toBe('A distribution for September 2026 has already been executed');
  });
});

describe('deviation', () => {
  const history = [
    { cycleId: '2026-08', total: '400' },
    { cycleId: '2026-07', total: '410' },
    { cycleId: '2026-06', total: '420' },
  ];

  it('passes with "No earlier cycles to compare" when there is no history', () => {
    const result = checkDeviation({ total: '1200', history: [], deviationPct: '50', symbol: 'CC' });
    expect(result).toMatchObject({
      code: 'deviation',
      passed: true,
      blocking: true,
      actual: 'No earlier cycles to compare',
    });
  });

  it('shows the real values, like "Total 1,200 CC vs 3-cycle average 410 CC, +193%"', () => {
    const result = checkDeviation({ total: '1200', history, deviationPct: '50', symbol: 'CC' });
    expect(result.passed).toBe(false);
    expect(result.actual).toBe('Total 1,200 CC vs 3-cycle average 410 CC, +193%');
    expect(result.limit).toBe('At most 50% from the 3-cycle average');
  });

  it('passes inside the threshold and treats the threshold itself as inside', () => {
    expect(checkDeviation({ total: '450', history, deviationPct: '50', symbol: 'CC' }).passed).toBe(
      true,
    );
    // 615 is exactly 50% above 410.
    expect(checkDeviation({ total: '615', history, deviationPct: '50', symbol: 'CC' }).passed).toBe(
      true,
    );
    expect(
      checkDeviation({ total: '615.0000000001', history, deviationPct: '50', symbol: 'CC' }).passed,
    ).toBe(false);
  });

  it('also flags a total far below the average', () => {
    const result = checkDeviation({ total: '100', history, deviationPct: '50', symbol: 'CC' });
    expect(result.passed).toBe(false);
    expect(result.actual).toBe('Total 100 CC vs 3-cycle average 410 CC, -76%');
  });

  it('uses the number of cycles it really averaged', () => {
    const result = checkDeviation({
      total: '500',
      history: history.slice(0, 2),
      deviationPct: '50',
      symbol: 'CC',
    });
    expect(result.actual).toBe('Total 500 CC vs 2-cycle average 405 CC, +23%');
  });

  it('selects the trailing cycles before this one, newest first', () => {
    const all = [
      ...history,
      { cycleId: '2026-05', total: '1' },
      { cycleId: '2026-10', total: '9999' }, // a later cycle is not "earlier"
      { cycleId: '2026-09', total: '9999' }, // the cycle itself is not history
    ];
    expect(selectHistory(all, '2026-09', 3).map((h) => h.cycleId)).toEqual([
      '2026-08',
      '2026-07',
      '2026-06',
    ]);
    expect(selectHistory(all, '2026-09', 0)).toEqual([]);
  });
});

describe('unit_spike', () => {
  const day = '2026-09-30';
  const baseChanges = [
    { holder: 'a', delta: 100, effectiveDate: '2026-01-01' },
    { holder: 'c', delta: 600, effectiveDate: '2026-01-01' },
  ];

  it('flags a holder whose units jumped, with the numbers', () => {
    const result = checkUnitSpike({
      changes: [...baseChanges, { holder: 'c', delta: 900, effectiveDate: '2026-09-25' }],
      recordDate: day,
      windowDays: 30,
      unitChangePct: '100',
      nameOf,
    });
    expect(result).toMatchObject({ code: 'unit_spike', passed: false, blocking: true });
    expect(result.actual).toBe('Holder C: 600 → 1,500 units (+150%) in the 30 days before Sep 30');
    expect(result.limit).toBe('No holder changes by more than 100% in the 30 days before Sep 30');
  });

  it('writes "1 unit" for a holder who ends with one unit', () => {
    const result = checkUnitSpike({
      changes: [...baseChanges, { holder: 'd', delta: 1, effectiveDate: '2026-09-29' }],
      recordDate: day,
      windowDays: 30,
      unitChangePct: '100',
      nameOf,
    });
    expect(result.actual).toBe('Holder D: 0 → 1 unit (new holder) in the 30 days before Sep 30');
  });

  it('counts a holder who went from 0 to positive inside the window as a spike', () => {
    const result = checkUnitSpike({
      changes: [...baseChanges, { holder: 'd', delta: 5, effectiveDate: '2026-09-29' }],
      recordDate: day,
      windowDays: 30,
      unitChangePct: '100000',
      nameOf,
    });
    expect(result.passed).toBe(false);
    expect(result.actual).toBe('Holder D: 0 → 5 units (new holder) in the 30 days before Sep 30');
  });

  it('passes a change within the threshold and shows the largest one', () => {
    const result = checkUnitSpike({
      changes: [...baseChanges, { holder: 'c', delta: 60, effectiveDate: '2026-09-25' }],
      recordDate: day,
      windowDays: 30,
      unitChangePct: '25',
      nameOf,
    });
    expect(result.passed).toBe(true);
    expect(result.actual).toBe(
      'Largest change: Holder C: 600 → 660 units (+10%) in the 30 days before Sep 30',
    );
  });

  it('passes with a plain statement when nothing changed in the window', () => {
    const result = checkUnitSpike({
      changes: baseChanges,
      recordDate: day,
      windowDays: 3,
      unitChangePct: '100',
      nameOf,
    });
    expect(result.passed).toBe(true);
    expect(result.actual).toBe('No unit changes in the 3 days before Sep 30');
  });

  it('ignores changes after the record date and before the window', () => {
    const result = checkUnitSpike({
      changes: [
        ...baseChanges,
        { holder: 'c', delta: 5000, effectiveDate: '2026-10-02' }, // after the record date
        { holder: 'a', delta: 5000, effectiveDate: '2026-06-01' }, // long before the window
      ],
      recordDate: day,
      windowDays: 30,
      unitChangePct: '25',
      nameOf,
    });
    expect(result.passed).toBe(true);
    expect(result.actual).toBe('No unit changes in the 30 days before Sep 30');
  });

  it('flags a holder who sold most of their units', () => {
    const result = checkUnitSpike({
      changes: [...baseChanges, { holder: 'c', delta: -500, effectiveDate: '2026-09-20' }],
      recordDate: day,
      windowDays: 30,
      unitChangePct: '50',
      nameOf,
    });
    expect(result.passed).toBe(false);
    expect(result.actual).toBe('Holder C: 600 → 100 units (-83%) in the 30 days before Sep 30');
  });
});

describe('prompt_amount', () => {
  it('is not applicable without a fixed amount', () => {
    expect(
      checkPromptAmount({ trigger: 'prompt', total: '999', fixedAmount: null, symbol: 'CC' }),
    ).toMatchObject({
      code: 'prompt_amount',
      passed: true,
      blocking: true,
      actual: 'Not applicable',
    });
  });

  it('is not applicable when the trigger is not a prompt', () => {
    for (const trigger of ['schedule', 'manual'] as const) {
      const result = checkPromptAmount({
        trigger,
        total: '999',
        fixedAmount: '1000',
        symbol: 'CC',
      });
      expect(result.passed).toBe(true);
      expect(result.actual).toBe('Not applicable');
    }
  });

  it('fails when a prompt asked for another amount than the fixed one', () => {
    const result = checkPromptAmount({
      trigger: 'prompt',
      total: '1500',
      fixedAmount: '1000',
      symbol: 'CC',
    });
    expect(result.passed).toBe(false);
    expect(result.actual).toBe(
      "A prompt asked for 1,500 CC, the policy's fixed amount is 1,000 CC",
    );
  });

  it('passes when the prompt matches the fixed amount', () => {
    const result = checkPromptAmount({
      trigger: 'prompt',
      total: '1000.0',
      fixedAmount: '1000',
      symbol: 'CC',
    });
    expect(result.passed).toBe(true);
    expect(result.actual).toBe("Prompt amount 1,000 CC matches the policy's fixed amount");
  });
});

describe('runChecks', () => {
  const inputs: CheckInputs = {
    symbol: 'CC',
    nameOf,
    cycleId: '2026-09',
    recordDate: '2026-09-30',
    trigger: 'manual',
    total: '300',
    payouts: [
      { holder: 'a', units: 100, amount: '100.0000000000' },
      { holder: 'b', units: 200, amount: '200.0000000000' },
    ],
    holdingsOnRecordDate: [
      { holder: 'a', units: 100 },
      { holder: 'b', units: 200 },
    ],
    changes: [
      { holder: 'a', delta: 100, effectiveDate: '2026-01-01' },
      { holder: 'b', delta: 200, effectiveDate: '2026-01-01' },
    ],
    terms: {
      cap: '5000',
      feeBuffer: '1',
      deviationPct: '50',
      trailingCycles: 3,
      unitChangePct: '25',
      unitChangeWindowDays: 30,
      fixedAmount: null,
    },
    balance: '100000',
    alreadyExecuted: false,
    executedHistory: [],
  };

  it('runs all seven checks in the order of details.md, every one deterministic', () => {
    const checks = runChecks(inputs);
    expect(checks.map((c) => c.code)).toEqual([
      'cap',
      'balance',
      'non_holder',
      'duplicate_cycle',
      'deviation',
      'unit_spike',
      'prompt_amount',
    ]);
    expect(checks.every((c) => c.source === 'deterministic')).toBe(true);
    expect(checks.every((c) => c.passed)).toBe(true);
    // Only the balance check is non-blocking.
    expect(checks.filter((c) => !c.blocking).map((c) => c.code)).toEqual(['balance']);
  });

  it('shows a failing check without hiding the others', () => {
    const checks = runChecks({ ...inputs, total: '6000', balance: '10' });
    expect(checks.filter((c) => !c.passed).map((c) => c.code)).toEqual(['cap', 'balance']);
  });
});
