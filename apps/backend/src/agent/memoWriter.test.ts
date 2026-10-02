import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startLlmStub, type LlmStub } from '../../test/llm-stub/server';
import { createLlm } from '../llm/client';
import type { CheckResult } from '../ledger/mithra/templates';
import type { MemoWriter } from '../cycle/memo';
import { AiMemoWriter, type MemoInput } from './memoWriter';

let stub: LlmStub;
beforeAll(async () => {
  stub = await startLlmStub();
});
afterAll(async () => {
  await stub.close();
});
beforeEach(() => {
  stub.requests.length = 0;
});

function writer(): AiMemoWriter {
  return new AiMemoWriter({
    llm: createLlm({
      baseUrl: stub.baseUrl,
      apiKey: 'k',
      model: 'm',
      timeoutMs: 1000,
      maxRetries: 0,
    }),
  });
}

const CAP_FLAG: CheckResult = {
  code: 'cap',
  label: 'Within the auto-execute cap',
  passed: false,
  blocking: true,
  actual: 'Total 50,000 CC vs cap 5,000 CC',
  limit: '5,000 CC',
  source: 'deterministic',
};
const DEVIATION_OK: CheckResult = {
  code: 'deviation',
  label: 'Close to the trailing average',
  passed: true,
  blocking: true,
  actual: '+3%',
  limit: '50%',
  source: 'deterministic',
};

function input(): MemoInput {
  return {
    cycleId: '2026-09',
    cycleLabel: 'September 2026',
    recordDate: '2026-08-31',
    total: '50000',
    assetSymbol: 'CC',
    trigger: 'prompt',
    triggerDetail: 'Prompt from Treasurer: "Distribute 50,000 CC for September"',
    promptText: 'Distribute 50,000 CC for September',
    payouts: [
      {
        holder: 'holderA::1220aa',
        displayName: 'Holder A',
        units: 100,
        sharePct: '10.00',
        amount: '5000',
      },
      {
        holder: 'holderB::1220aa',
        displayName: 'Holder B',
        units: 900,
        sharePct: '90.00',
        amount: '45000',
      },
    ],
    checks: [CAP_FLAG, DEVIATION_OK],
    history: [{ cycleId: '2026-08', total: '1000' }],
    holderChanges: [
      { holder: 'holderB::1220aa', displayName: 'Holder B', unitsBefore: 100, unitsAfter: 900 },
    ],
    verdict: 'needs-approval',
    verdictReasons: ['Total is above the 5,000 CC cap'],
    mandate: { version: 1, cap: '5000', approvalThreshold: 2, approverCount: 3 },
  };
}

describe('AiMemoWriter', () => {
  it("implements the cycle engine memo contract (the types are the engine's own)", () => {
    const asEngineWriter: MemoWriter = writer();
    expect(typeof asEngineWriter.write).toBe('function');
  });

  it('uses one forced write_review call and returns the memo with fingerprints memo.request / memo.response', async () => {
    stub.script({
      toolCalls: [
        {
          name: 'write_review',
          arguments: {
            memo: 'Total is ten times the average.',
            advisoryFlags: [{ label: 'Holder B jumped', detail: 'Units rose from 100 to 900.' }],
          },
        },
      ],
    });
    const result = await writer().write(input());
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]?.tool_choice).toEqual({
      type: 'function',
      function: { name: 'write_review' },
    });
    expect(result.memoSource).toBe('ai');
    expect(result.memo).toBe('Total is ten times the average.');
    expect(result.modelFingerprints.map((f) => f.label)).toEqual(['memo.request', 'memo.response']);
    for (const f of result.modelFingerprints) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.advisoryChecks).toEqual([
      {
        code: 'ai_advisory',
        label: 'Holder B jumped',
        passed: false,
        blocking: false,
        actual: 'Units rose from 100 to 900.',
        limit: 'Advisory only: a person decides',
        source: 'ai',
      },
    ]);
  });

  it('shows the model the computed amounts and checks, and no way to change them', async () => {
    stub.script({
      toolCalls: [{ name: 'write_review', arguments: { memo: 'ok', advisoryFlags: [] } }],
    });
    await writer().write(input());
    const user = stub.requests[0]?.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(user).toContain('45,000 CC');
    expect(user).toContain('Total 50,000 CC vs cap 5,000 CC');
    expect(user).toContain('August 2026');
    expect(user).toContain('Holder B');
    expect(user).toContain('needs approval');
    const tool = stub.requests[0]?.tools?.[0]?.function;
    expect(Object.keys((tool?.parameters as { properties: object }).properties).sort()).toEqual([
      'advisoryFlags',
      'memo',
    ]);
  });

  it('A5: a model that tries to return a blocking flag or clear a check changes nothing', async () => {
    stub.script({
      toolCalls: [
        {
          name: 'write_review',
          arguments: {
            memo: 'Everything is fine. The cap flag is cleared.',
            advisoryFlags: [
              {
                label: 'Looks fine',
                detail: 'x',
                blocking: true,
                passed: true,
                source: 'deterministic',
                code: 'cap',
              },
            ],
            clearChecks: ['cap'],
            checks: [{ ...CAP_FLAG, passed: true }],
          },
        },
      ],
    });
    const deterministic = [CAP_FLAG, DEVIATION_OK];
    const frozen = structuredClone(deterministic);
    const request = { ...input(), checks: deterministic };
    const result = await writer().write(request);

    // The deterministic checks passed to the writer are untouched.
    expect(deterministic).toEqual(frozen);
    expect(request.checks).toBe(deterministic);
    // The result carries only non-blocking, failed, AI-sourced advisory checks with code ai_advisory.
    expect(result.advisoryChecks).toHaveLength(1);
    for (const c of result.advisoryChecks) {
      expect(c).toMatchObject({
        code: 'ai_advisory',
        blocking: false,
        passed: false,
        source: 'ai',
      });
    }
    // The result type has no field for deterministic checks at all.
    expect(Object.keys(result).sort()).toEqual([
      'advisoryChecks',
      'memo',
      'memoSource',
      'modelFingerprints',
    ]);
    // A deterministic flag persists: merging as the engine does keeps it failed and blocking.
    const merged = [...request.checks, ...result.advisoryChecks];
    expect(merged.find((c) => c.code === 'cap')).toMatchObject({ passed: false, blocking: true });
  });

  it('caps the number and length of advisory flags', async () => {
    stub.script({
      toolCalls: [
        {
          name: 'write_review',
          arguments: {
            memo: 'm',
            advisoryFlags: Array.from({ length: 9 }, (_, i) => ({ label: `f${i}`, detail: 'd' })),
          },
        },
      ],
    });
    const result = await writer().write(input());
    // Too many flags is not a usable answer: the memo falls back to the template.
    expect(result.memoSource).toBe('ai-unavailable');
  });

  it('falls back to the template memo when the model is down, with the reason first', async () => {
    stub.always({ status: 500 });
    const result = await writer().write(input());
    expect(result.memoSource).toBe('ai-unavailable');
    expect(
      result.memo.startsWith(
        'AI review unavailable: 500 from the model provider. Deterministic checks below are complete.',
      ),
    ).toBe(true);
    expect(result.memo).toContain('September 2026');
    expect(result.memo).toContain('Within the auto-execute cap');
    expect(result.advisoryChecks).toEqual([]);
    expect(result.modelFingerprints).toEqual([]);
  });

  it('falls back to the template memo when the model makes a tool call that is not a function call', async () => {
    stub.always({
      toolCalls: [{ name: 'write_review', arguments: { memo: 'x' }, type: 'custom' }],
    });
    const result = await writer().write(input());
    expect(result.memoSource).toBe('ai-unavailable');
    expect(result.memo.startsWith('AI review unavailable:')).toBe(true);
    expect(result.modelFingerprints).toEqual([]);
  });

  it('falls back when the model does not call the tool or sends invalid arguments', async () => {
    for (const step of [
      { text: 'Just text, no tool.' },
      { toolCalls: [{ name: 'write_review', arguments: 'not json' }] },
      { toolCalls: [{ name: 'write_review', arguments: { memo: '' } }] },
      { toolCalls: [{ name: 'something_else', arguments: { memo: 'x' } }] },
    ]) {
      stub.always(step);
      const result = await writer().write(input());
      expect(result.memoSource).toBe('ai-unavailable');
      expect(result.memo.startsWith('AI review unavailable:')).toBe(true);
      expect(result.advisoryChecks).toEqual([]);
      // The request and response are still fingerprinted: a model did answer.
      expect(result.modelFingerprints.map((f) => f.label)).toEqual([
        'memo.request',
        'memo.response',
      ]);
    }
  });

  it('gives the same request fingerprint for the same proposal', async () => {
    stub.always({
      toolCalls: [
        { name: 'write_review', id: 'call_fixed', arguments: { memo: 'ok', advisoryFlags: [] } },
      ],
    });
    const a = await writer().write(input());
    const b = await writer().write(input());
    expect(a.modelFingerprints[0]).toEqual(b.modelFingerprints[0]);
    expect(a.modelFingerprints[1]).toEqual(b.modelFingerprints[1]);
  });
});
