import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startLlmStub, type LlmStub } from '../../test/llm-stub/server';
import { createLlm } from '../llm/client';
import { createScopeDrafter, draftAuditScope, rulesScope, type CatalogEntry } from './scope';

const CATALOG: CatalogEntry[] = [
  {
    recordId: 'decision/2026-06/1',
    kind: 'decision',
    cycleId: '2026-06',
    cycleLabel: 'June 2026',
    flagged: false,
    executedAt: '2026-07-01T09:05:00Z',
  },
  {
    recordId: 'outcome/2026-06/1',
    kind: 'outcome',
    cycleId: '2026-06',
    cycleLabel: 'June 2026',
    flagged: false,
    executedAt: '2026-07-01T09:05:00Z',
  },
  {
    recordId: 'decision/2026-07/1',
    kind: 'decision',
    cycleId: '2026-07',
    cycleLabel: 'July 2026',
    flagged: false,
    executedAt: '2026-08-01T09:05:00Z',
  },
  {
    recordId: 'outcome/2026-07/1',
    kind: 'outcome',
    cycleId: '2026-07',
    cycleLabel: 'July 2026',
    flagged: false,
    executedAt: '2026-08-01T09:05:00Z',
  },
  {
    recordId: 'decision/2026-08/1',
    kind: 'decision',
    cycleId: '2026-08',
    cycleLabel: 'August 2026',
    flagged: true,
    executedAt: '2026-09-02T10:00:00Z',
  },
  {
    recordId: 'outcome/2026-08/1',
    kind: 'outcome',
    cycleId: '2026-08',
    cycleLabel: 'August 2026',
    flagged: true,
    executedAt: '2026-09-02T10:00:00Z',
  },
  {
    recordId: 'decision/2026-09/1',
    kind: 'decision',
    cycleId: '2026-09',
    cycleLabel: 'September 2026',
    flagged: false,
    executedAt: null,
  },
  {
    recordId: 'outcome/2026-09/1',
    kind: 'outcome',
    cycleId: '2026-09',
    cycleLabel: 'September 2026',
    flagged: false,
    executedAt: '2026-10-01T09:05:00Z',
  },
];

const DEMO_QUESTION = 'Show all Q3 distributions and the approvals behind any flagged one';

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

const llm = () =>
  createLlm({ baseUrl: stub.baseUrl, apiKey: 'k', model: 'm', timeoutMs: 1000, maxRetries: 0 });

describe('rules fallback', () => {
  it('handles the demo question: all Q3 outcomes plus the decision records of flagged cycles', () => {
    const scope = rulesScope(DEMO_QUESTION, CATALOG);
    expect(scope.source).toBe('rules');
    expect(scope.excluded).toBe(
      'Holder identities are shown as Holder A to D unless you ask for them',
    );
    // Q3 = July, August, September. June is out. Decision records only for the flagged cycle (August).
    expect(scope.items.map((i) => i.recordId)).toEqual([
      'outcome/2026-07/1',
      'decision/2026-08/1',
      'outcome/2026-08/1',
      'outcome/2026-09/1',
    ]);
    for (const item of scope.items) {
      expect(item.reason.length).toBeGreaterThan(10);
      expect(item.kind).toBe(CATALOG.find((c) => c.recordId === item.recordId)?.kind);
    }
  });

  it('"flagged" alone keeps only the flagged cycles\' decision and outcome', () => {
    expect(
      rulesScope('Show the flagged distribution', CATALOG).items.map((i) => i.recordId),
    ).toEqual(['decision/2026-08/1', 'outcome/2026-08/1']);
  });

  it('without a period or "flagged" it returns all records, in cycle order', () => {
    expect(rulesScope('Show me everything', CATALOG).items).toHaveLength(8);
  });

  it('parses quarters, month names and years', () => {
    const ids = (q: string): string[] => rulesScope(q, CATALOG).items.map((i) => i.recordId);
    expect(ids('Q2 2026')).toEqual(['decision/2026-06/1', 'outcome/2026-06/1']);
    expect(ids('records for July')).toEqual(['decision/2026-07/1', 'outcome/2026-07/1']);
    expect(ids('what happened in september 2026?')).toEqual([
      'decision/2026-09/1',
      'outcome/2026-09/1',
    ]);
    expect(ids('Q3 2025')).toEqual([]);
    expect(ids('Q3 2026')).toHaveLength(6);
    // "may" as a verb is not the month.
    expect(ids('what may have happened')).toHaveLength(8);
  });
});

describe('AI scope', () => {
  it('keeps only record ids that exist in the catalog, takes the kind from the catalog, removes duplicates', async () => {
    stub.script({
      toolCalls: [
        {
          name: 'propose_scope',
          arguments: {
            items: [
              { recordId: 'outcome/2026-08/1', reason: 'What was paid in August' },
              { recordId: 'outcome/2026-08/1', reason: 'duplicate' },
              { recordId: 'decision/2099-01/1', reason: 'invented' },
              { recordId: 'decision/2026-08/1', reason: 'Why August was flagged', kind: 'outcome' },
            ],
            excluded: 'Holder identities and the memo text',
          },
        },
      ],
    });
    const scope = await draftAuditScope(llm(), DEMO_QUESTION, CATALOG);
    expect(scope).toEqual({
      source: 'ai',
      excluded: 'Holder identities and the memo text',
      items: [
        { recordId: 'outcome/2026-08/1', kind: 'outcome', reason: 'What was paid in August' },
        { recordId: 'decision/2026-08/1', kind: 'decision', reason: 'Why August was flagged' },
      ],
    });
  });

  it('tells the model to prefer the smallest set and shows it the catalog, not holder identities', async () => {
    stub.script({
      toolCalls: [
        {
          name: 'propose_scope',
          arguments: { items: [{ recordId: 'outcome/2026-08/1', reason: 'r' }], excluded: '' },
        },
      ],
    });
    const scope = await draftAuditScope(llm(), DEMO_QUESTION, CATALOG);
    expect(scope.excluded).toBe(
      'Holder identities are shown as Holder A to D unless you ask for them',
    );
    const request = stub.requests[0];
    const system = request?.messages[0]?.content ?? '';
    expect(system).toContain('smallest set');
    expect(request?.tool_choice).toEqual({ type: 'function', function: { name: 'propose_scope' } });
    const user = request?.messages[1]?.content ?? '';
    expect(user).toContain('decision/2026-08/1 | decision | August 2026 | flagged');
    expect(user).toContain(DEMO_QUESTION);
  });

  it('falls back to rules when the model is down (A11), when it sends junk, or when every id is invented', async () => {
    const expected = rulesScope(DEMO_QUESTION, CATALOG);
    for (const step of [
      { status: 500 },
      { text: 'Here is a scope in prose.' },
      { toolCalls: [{ name: 'propose_scope', arguments: 'not json' }] },
      { toolCalls: [{ name: 'propose_scope', arguments: { items: 'all of them' } }] },
      {
        toolCalls: [
          {
            name: 'propose_scope',
            arguments: { items: [{ recordId: 'made-up', reason: 'x' }], excluded: '' },
          },
        ],
      },
    ]) {
      stub.always(step);
      expect(await draftAuditScope(llm(), DEMO_QUESTION, CATALOG)).toEqual(expected);
    }
  });

  it('honors a model answer of "nothing fits"', async () => {
    stub.always({
      toolCalls: [
        {
          name: 'propose_scope',
          arguments: { items: [], excluded: 'Nothing in the catalog answers this.' },
        },
      ],
    });
    expect(await draftAuditScope(llm(), 'What is the weather?', CATALOG)).toEqual({
      items: [],
      excluded: 'Nothing in the catalog answers this.',
      source: 'ai',
    });
  });

  it('reads the catalog per request through the drafter', async () => {
    let reads = 0;
    const drafter = createScopeDrafter({
      llm: llm(),
      catalog: () => {
        reads += 1;
        return Promise.resolve(CATALOG);
      },
    });
    stub.always({ status: 500 });
    await drafter.draft('flagged');
    await drafter.draft('flagged');
    expect(reads).toBe(2);
  });
});
