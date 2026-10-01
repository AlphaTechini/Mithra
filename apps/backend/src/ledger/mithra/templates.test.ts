import { describe, expect, it } from 'vitest';
import {
  EvidenceRefSchema,
  EvidenceSchema,
  MITHRA_PAYLOAD_SCHEMAS,
  MITHRA_TEMPLATE_ENTITIES,
  DistributionOutcomeSchema,
  MandateTermsSchema,
  mithraTemplateIds,
} from './templates';
import { entityOf } from '../types';

describe('template ids', () => {
  it('builds package-name ids for every template from MITHRA_PACKAGE', () => {
    const ids = mithraTemplateIds('#mithra-v1');
    expect(ids.Organization).toBe('#mithra-v1:Mithra.Org:Organization');
    expect(ids.MandateChangeProposal).toBe('#mithra-v1:Mithra.Governance:MandateChangeProposal');
    expect(Object.keys(ids)).toHaveLength(18);
    expect(Object.keys(MITHRA_PAYLOAD_SCHEMAS).sort()).toEqual(
      Object.keys(MITHRA_TEMPLATE_ENTITIES).sort(),
    );
  });

  it('compares ids by Module:Entity, whatever the package part', () => {
    expect(entityOf('655e242af9d6:Mithra.Org:Organization')).toBe('Mithra.Org:Organization');
    expect(entityOf('#mithra-v1:Mithra.Org:Organization')).toBe('Mithra.Org:Organization');
  });
});

const terms = {
  cap: '5000.0000000000',
  approvers: ['a1', 'a2'],
  approvalThreshold: '2',
  asset: { admin: 'dso', id: 'Amulet' },
  scheduleCron: '0 9 1 * *',
  scheduleTimezone: 'UTC',
  recordDateRule: 'last_day_of_previous_month',
  deviationPct: '50.0000000000',
  trailingCycles: '3',
  unitChangePct: '25.0000000000',
  unitChangeWindowDays: '30',
  feeBuffer: '1.0000000000',
};

describe('payload decoding', () => {
  it('turns ints into numbers and keeps decimals as strings', () => {
    const parsed = MandateTermsSchema.parse({ ...terms, fixedAmount: '120.5' });
    expect(parsed.approvalThreshold).toBe(2);
    expect(parsed.cap).toBe('5000.0000000000');
    expect(parsed.fixedAmount).toBe('120.5');
  });

  it('reads an omitted or null Optional as null', () => {
    expect(MandateTermsSchema.parse(terms).fixedAmount).toBeNull();
    expect(MandateTermsSchema.parse({ ...terms, fixedAmount: null }).fixedAmount).toBeNull();
  });

  it('decodes a distribution outcome whose payment references omit the missing instruction', () => {
    const outcome = DistributionOutcomeSchema.parse({
      recordId: 'outcome/2026-09/1',
      treasury: 't',
      treasurer: 'r',
      agent: 'g',
      approvers: ['a1'],
      decisionRecordId: 'decision/2026-09/1',
      cycleId: '2026-09',
      cycleLabel: 'September 2026',
      kind: 'Executed',
      approvals: [{ approver: 'a1', at: '2026-10-01T09:00:00Z', note: 'ok' }],
      payments: [
        { holder: 'h1', amount: '500.0000000000', paymentCid: '00aa', status: 'Paid' },
        {
          holder: 'h2',
          amount: '1500',
          paymentCid: '00bb',
          status: 'AwaitingAcceptance',
          transferInstructionCid: '00cc',
        },
      ],
      actor: 'g',
      reason: null,
      at: '2026-10-01T09:00:00Z',
      seeded: false,
    });
    expect(outcome.payments.map((p) => p.transferInstructionCid)).toEqual([null, '00cc']);
    expect(outcome.reason).toBeNull();
  });

  it('rejects an amount sent as a JSON number', () => {
    expect(() => MandateTermsSchema.parse({ ...terms, cap: 5000 })).toThrow();
  });

  it('decodes the Evidence and EvidenceRef variants', () => {
    expect(EvidenceRefSchema.parse({ tag: 'RefDecision', value: '00aa' })).toEqual({
      tag: 'RefDecision',
      value: '00aa',
    });
    expect(EvidenceRefSchema.parse({ tag: 'RefOutcome', value: '00bb' }).tag).toBe('RefOutcome');
    expect(() => EvidenceRefSchema.parse({ tag: 'RefOther', value: '00bb' })).toThrow();
    expect(() => EvidenceSchema.parse({ tag: 'EvDecision', value: {} })).toThrow();
  });
});
