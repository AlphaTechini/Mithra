import { describe, expect, it } from 'vitest';
import type { CheckResult } from '../ledger';
import { TemplateMemoWriter, sanitizeAdvisoryChecks, type MemoInput } from './memo';

const failedDeviation: CheckResult = {
  code: 'deviation',
  label: 'Total is in line with earlier cycles',
  passed: false,
  blocking: true,
  actual: 'Total 1,200 CC vs 3-cycle average 410 CC, +193%',
  limit: 'At most 50% from the 3-cycle average',
  source: 'deterministic',
};
const passedCap: CheckResult = {
  code: 'cap',
  label: 'Within the auto-execute cap',
  passed: true,
  blocking: true,
  actual: 'Total 1,200 CC vs cap 5,000 CC',
  limit: 'At most 5,000 CC',
  source: 'deterministic',
};

const input: MemoInput = {
  cycleId: '2026-09',
  cycleLabel: 'September 2026',
  recordDate: '2026-09-30',
  total: '1200',
  assetSymbol: 'CC',
  trigger: 'prompt',
  triggerDetail: 'Prompt by Treasurer',
  promptText: 'Distribute 1,200 CC for September',
  payouts: [
    {
      holder: 'a',
      displayName: 'Holder A',
      units: 100,
      sharePct: '10.00',
      amount: '120.0000000000',
    },
    {
      holder: 'c',
      displayName: 'Holder C',
      units: 900,
      sharePct: '90.00',
      amount: '1080.0000000000',
    },
  ],
  checks: [passedCap, failedDeviation],
  history: [{ cycleId: '2026-08', total: '410' }],
  holderChanges: [{ holder: 'c', displayName: 'Holder C', unitsBefore: 600, unitsAfter: 900 }],
  verdict: 'needs-approval',
  verdictReasons: ['Total 1,200 CC vs 3-cycle average 410 CC, +193%'],
  mandate: { version: 1, cap: '5000', approvalThreshold: 2, approverCount: 3 },
};

describe('TemplateMemoWriter', () => {
  const writer = new TemplateMemoWriter();

  it('is deterministic, plain English and names every failed check with its values', async () => {
    const one = await writer.write(input);
    const two = await writer.write(input);
    expect(one).toEqual(two);
    expect(one.memoSource).toBe('template');
    expect(one.advisoryChecks).toEqual([]);
    expect(one.modelFingerprints).toEqual([]);
    expect(one.memo).toContain('September 2026: 1,200 CC is split pro rata over 2 holders');
    expect(one.memo).toContain('Sep 30');
    expect(one.memo).toContain('1 of 2 checks flagged');
    expect(one.memo).toContain(
      '- Total is in line with earlier cycles: Total 1,200 CC vs 3-cycle average 410 CC, +193%',
    );
    expect(one.memo).toContain('Holder C 600 → 900 units');
    expect(one.memo).toContain('needs 2 of 3 approvals');
  });

  it('says a clean proposal is within the mandate and can be held', async () => {
    const clean = await writer.write({
      ...input,
      checks: [passedCap],
      verdict: 'within-mandate',
      verdictReasons: [],
      holderChanges: [],
      history: [],
    });
    expect(clean.memo).toContain('All 1 checks passed.');
    expect(clean.memo).toContain('within the mandate');
    expect(clean.memo).toContain('Hold');
  });
});

describe('sanitizeAdvisoryChecks (A5)', () => {
  const advisory: CheckResult = {
    code: 'ai_advisory',
    label: 'Holder C grew fast',
    passed: false,
    blocking: false,
    actual: 'Holder C units rose 50% in a month',
    limit: 'advisory',
    source: 'ai',
  };

  it('keeps a non-blocking AI check', () => {
    expect(sanitizeAdvisoryChecks([advisory])).toEqual([advisory]);
  });

  it('drops a blocking AI check', () => {
    expect(sanitizeAdvisoryChecks([{ ...advisory, blocking: true }])).toEqual([]);
  });

  it('drops a check whose source is not ai, including one that tries to clear a deterministic flag', () => {
    const clearing: CheckResult = { ...failedDeviation, passed: true, source: 'deterministic' };
    expect(sanitizeAdvisoryChecks([clearing])).toEqual([]);
    expect(sanitizeAdvisoryChecks([{ ...advisory, source: 'human' }])).toEqual([]);
  });

  it('drops an AI check that reuses a deterministic code (it could look like the real check)', () => {
    expect(sanitizeAdvisoryChecks([{ ...advisory, code: 'deviation', passed: true }])).toEqual([]);
  });

  it('caps the number of advisory checks', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ...advisory, code: `ai_${i}` }));
    expect(sanitizeAdvisoryChecks(many)).toHaveLength(5);
  });
});
