import { describe, expect, it } from 'vitest';
import { localnetTestConfig, mainnetTestConfig } from '../testConfig';
import type { MithraPayloads } from '../ledger';
import { buildPosition, opaqueId, txLinkFor } from './position';

type Change = MithraPayloads['UnitRegister']['changes'][number];

const change = (holder: string, delta: number): Change => ({
  holder,
  delta,
  effectiveDate: '2026-08-01',
  recordedAt: '2026-08-01T00:00:00Z',
  seeded: false,
});

function payment(
  holder: string,
  amount: string,
  status: 'Paid' | 'AwaitingAcceptance',
  executedAt: string,
  cid = `p-${holder}-${executedAt}`,
) {
  const payload: MithraPayloads['Payment'] = {
    treasury: 'treasury',
    agent: 'agent',
    holder,
    cycleId: executedAt.slice(0, 7),
    cycleLabel: `Cycle ${executedAt.slice(0, 7)}`,
    units: 1,
    amount,
    status,
    transferInstructionCid: status === 'Paid' ? null : `ti-${cid}`,
    executedAt,
    seeded: false,
  };
  return { contractId: cid, payload, createdAt: executedAt };
}

function fundUnit(holder: string, units: number, accepted: boolean) {
  const payload: MithraPayloads['FundUnit'] = {
    treasury: 'treasury',
    holder,
    orgName: 'Acme Fund',
    units,
    effectiveDate: '2026-08-15',
    issuedAt: '2026-08-15T00:00:00Z',
    accepted,
    seeded: false,
  };
  return {
    contractId: `fu-${holder}-${units}-${String(accepted)}`,
    payload,
    createdAt: '2026-08-15T00:00:00Z',
  };
}

const config = localnetTestConfig();
const changes = [change('alice', 100), change('bob', 300)];

describe('txLinkFor', () => {
  it('links to the in-app holder detail on LocalNet', () => {
    expect(txLinkFor(config, '1220abc')).toEqual({
      updateId: '1220abc',
      href: '/holder/tx/1220abc',
      external: false,
    });
  });

  it('links to the explorer on MainNet', () => {
    expect(txLinkFor(mainnetTestConfig(), '1220abc')).toEqual({
      updateId: '1220abc',
      href: 'https://explorer.example/tx/1220abc',
      external: true,
    });
  });
});

describe('opaqueId', () => {
  it('is a short, stable id that fits a URL path and hides the contract id', () => {
    const cid = '00' + 'ab'.repeat(68);
    expect(opaqueId(cid)).toMatch(/^[0-9a-f]{32}$/);
    expect(opaqueId(cid)).toBe(opaqueId(cid));
    expect(opaqueId(cid)).not.toBe(opaqueId(cid + '0'));
    expect(opaqueId(cid)).not.toContain('abab');
  });
});

describe('buildPosition', () => {
  const base = {
    config,
    orgName: 'Acme Fund',
    holder: 'alice',
    changes,
    fundUnits: [],
    payments: [],
    updateIds: new Map<string, string>(),
    nextPayment: null,
    autoReceive: true,
  };

  it('links a Payment that Payment_MarkAccepted recreated: its new contract id has its own reference', () => {
    // The reconciler records the accepting transaction against the new Paid Payment (kind
    // "payment"); the archived AwaitingAcceptance Payment is no longer read, so only the new id counts.
    const recreated = payment('alice', '30.0000000000', 'Paid', '2026-09-01T09:00:00Z', 'p-new');
    const position = buildPosition({
      ...base,
      payments: [recreated],
      updateIds: new Map([
        ['p-old', 'upd-execute'],
        ['p-new', 'upd-accept'],
      ]),
    });
    expect(position.payments).toHaveLength(1);
    expect(position.payments[0]).toMatchObject({
      status: 'paid',
      link: { updateId: 'upd-accept', href: '/holder/tx/upd-accept', external: false },
    });
    expect(position.totalReceived).toBe('30.0000000000');
  });

  it('gives units, share, totals, links and pending units for the holder', () => {
    const position = buildPosition({
      ...base,
      fundUnits: [fundUnit('alice', 100, false), fundUnit('alice', 20, true)],
      payments: [
        payment('alice', '10.0000000000', 'Paid', '2026-08-01T09:00:00Z'),
        payment('alice', '12.5000000000', 'Paid', '2026-09-01T09:00:00Z', 'p-sept'),
        payment('alice', '99.0000000000', 'AwaitingAcceptance', '2026-10-01T09:00:00Z', 'p-oct'),
      ],
      updateIds: new Map([['p-sept', 'upd-sept']]),
      nextPayment: '2026-11-01T09:00:00.000Z',
    });
    expect(position).toMatchObject({
      orgName: 'Acme Fund',
      assetSymbol: 'CC',
      units: 100,
      sharePct: '25.00',
      // Only Paid payments count as received.
      totalReceived: '22.5000000000',
      nextPaymentDate: '2026-11-01',
      autoReceive: true,
      pendingUnits: [
        { unitId: opaqueId('fu-alice-100-false'), units: 100, effectiveDate: '2026-08-15' },
      ],
    });
    // Newest first, with a link only where a transaction is known.
    expect(position.payments.map((p) => [p.paymentId, p.status, p.link?.href ?? null])).toEqual([
      [opaqueId('p-oct'), 'awaiting-acceptance', null],
      [opaqueId('p-sept'), 'paid', '/holder/tx/upd-sept'],
      [opaqueId('p-alice-2026-08-01T09:00:00Z'), 'paid', null],
    ]);
  });

  it("never includes another holder's data, even if it is passed in (L7, U7)", () => {
    const position = buildPosition({
      ...base,
      fundUnits: [fundUnit('alice', 100, false), fundUnit('bob', 300, false)],
      payments: [
        payment('alice', '5.0000000000', 'Paid', '2026-09-01T09:00:00Z'),
        payment('bob', '777.0000000000', 'Paid', '2026-09-01T09:00:00Z'),
      ],
    });
    const json = JSON.stringify(position);
    expect(json).not.toContain('bob');
    expect(json).not.toContain('777');
    expect(position.pendingUnits).toHaveLength(1);
    expect(position.payments).toHaveLength(1);
    expect(position.totalReceived).toBe('5.0000000000');
  });

  it('is empty and zero for a holder with nothing yet', () => {
    const position = buildPosition({ ...base, holder: 'carol', autoReceive: null });
    expect(position).toMatchObject({
      units: 0,
      sharePct: '0.00',
      totalReceived: '0.0000000000',
      nextPaymentDate: null,
      autoReceive: null,
      pendingUnits: [],
      payments: [],
    });
  });
});
