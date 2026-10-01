import { describe, expect, it } from 'vitest';
import type { MithraPayloads } from '../ledger';
import { buildHoldersResponse, netUnits, sharePct, totalUnitsOf } from './table';

type Change = MithraPayloads['UnitRegister']['changes'][number];

function change(holder: string, delta: number, seeded = false): Change {
  return {
    holder,
    delta,
    effectiveDate: '2026-08-01',
    recordedAt: '2026-08-01T00:00:00Z',
    seeded,
  };
}

function fundUnit(holder: string, units: number, accepted: boolean) {
  const payload: MithraPayloads['FundUnit'] = {
    treasury: 'treasury',
    holder,
    orgName: 'Acme Fund',
    units,
    effectiveDate: '2026-08-01',
    issuedAt: '2026-08-01T00:00:00Z',
    accepted,
    seeded: false,
  };
  return { contractId: `fu-${holder}-${units}`, payload, createdAt: '2026-08-01T00:00:00Z' };
}

function payment(holder: string, amount: string, executedAt: string, cycleLabel = 'August 2026') {
  const payload: MithraPayloads['Payment'] = {
    treasury: 'treasury',
    agent: 'agent',
    holder,
    cycleId: '2026-08',
    cycleLabel,
    units: 1,
    amount,
    status: 'Paid',
    transferInstructionCid: null,
    executedAt,
    seeded: false,
  };
  return { contractId: `p-${holder}-${executedAt}`, payload, createdAt: executedAt };
}

describe('sharePct', () => {
  it('has 2 decimals and rounds half to even', () => {
    expect(sharePct(1, 3)).toBe('33.33');
    expect(sharePct(2, 3)).toBe('66.67');
    expect(sharePct(1, 8)).toBe('12.50');
    // 1/16 = 6.25 exactly; 1/32 = 3.125 rounds half-even to 3.12
    expect(sharePct(1, 32)).toBe('3.12');
    expect(sharePct(3, 32)).toBe('9.38');
  });

  it('is 100.00 for the only holder and 0.00 without units', () => {
    expect(sharePct(500, 500)).toBe('100.00');
    expect(sharePct(0, 500)).toBe('0.00');
    expect(sharePct(5, 0)).toBe('0.00');
  });

  it('sums to 100.00 within rounding for many splits', () => {
    for (const split of [
      [1, 1, 1],
      [100, 300, 600, 1000],
      [7, 11, 13, 17, 19],
      [1, 99999],
    ]) {
      const total = split.reduce((a, b) => a + b, 0);
      // The shares are 2-decimal strings: add them as integers of hundredths, no JS float maths.
      const hundredths = split
        .map((u) => sharePct(u, total).replace('.', ''))
        .reduce((a, b) => a + Number(b), 0);
      expect(Math.abs(hundredths - 10000)).toBeLessThanOrEqual(split.length);
    }
  });

  it('gives exact shares for the integration fixture', () => {
    expect([100, 300, 600, 1000].map((u) => sharePct(u, 2000))).toEqual([
      '5.00',
      '15.00',
      '30.00',
      '50.00',
    ]);
  });
});

describe('netUnits', () => {
  it('adds deltas per holder and drops holders left with nothing', () => {
    const units = netUnits([change('a', 100), change('b', 50), change('a', -30), change('b', -50)]);
    expect([...units]).toEqual([['a', 70]]);
    expect(totalUnitsOf(units)).toBe(70);
  });
});

describe('buildHoldersResponse', () => {
  const names = new Map([
    ['a', 'Holder A'],
    ['b', 'Holder B'],
    ['c', 'Holder C'],
  ]);

  it('builds one row per holder, largest first, with share, auto-receive and last payment', () => {
    const response = buildHoldersResponse({
      changes: [change('a', 100), change('b', 300), change('c', 600, true)],
      fundUnits: [fundUnit('a', 100, true), fundUnit('b', 300, false), fundUnit('c', 600, true)],
      fundUnitsReadable: true,
      payments: [
        payment('a', '10.0000000000', '2026-09-01T09:00:00Z', 'August 2026'),
        payment('a', '12.0000000000', '2026-10-01T09:00:00Z', 'September 2026'),
      ],
      names,
      autoReceive: new Map([
        ['a', true],
        ['b', false],
      ]),
    });
    expect(response.totalUnits).toBe(1000);
    expect(response.holders.map((h) => h.holder.displayName)).toEqual([
      'Holder C',
      'Holder B',
      'Holder A',
    ]);
    const [c, b, a] = response.holders;
    expect(c).toMatchObject({ units: 600, sharePct: '60.00', unitsAccepted: true, seeded: true });
    expect(c?.autoReceive).toBeNull();
    expect(b).toMatchObject({
      units: 300,
      sharePct: '30.00',
      unitsAccepted: false,
      autoReceive: false,
    });
    expect(a).toMatchObject({
      units: 100,
      sharePct: '10.00',
      autoReceive: true,
      seeded: false,
      lastPayment: { amount: '12.0000000000', cycleLabel: 'September 2026' },
    });
    expect(b?.lastPayment).toBeNull();
  });

  it('does not claim acceptance when FundUnits cannot be read', () => {
    const response = buildHoldersResponse({
      changes: [change('a', 100)],
      fundUnits: [],
      fundUnitsReadable: false,
      payments: [],
      names,
      autoReceive: new Map(),
    });
    expect(response.holders[0]?.unitsAccepted).toBe(false);
  });

  it('shows a holder as accepted only when every tranche is accepted', () => {
    const response = buildHoldersResponse({
      changes: [change('a', 100), change('a', 50)],
      fundUnits: [fundUnit('a', 100, true), fundUnit('a', 50, false)],
      fundUnitsReadable: true,
      payments: [],
      names,
      autoReceive: new Map(),
    });
    expect(response.holders[0]).toMatchObject({ units: 150, unitsAccepted: false });
  });

  it('is empty with no register', () => {
    expect(
      buildHoldersResponse({
        changes: [],
        fundUnits: [],
        fundUnitsReadable: true,
        payments: [],
        names,
        autoReceive: new Map(),
      }),
    ).toEqual({ totalUnits: 0, holders: [] });
  });
});
