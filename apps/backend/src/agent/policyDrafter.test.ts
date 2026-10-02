import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startLlmStub, type LlmStub } from '../../test/llm-stub/server';
import { createLlm } from '../llm/client';
import { createFakeServices, FAKE_PARTIES, type FakeServices } from './fakes';
import { createPolicyDrafter } from './policyDrafter';
import { createMemoryAgentStore } from './store';

const DEMO_PROMPT =
  'Pay monthly yield on the 1st. Auto-pay if the total is under 5,000 CC and nothing looks off. Otherwise 2 of 3 approvals.';

let stub: LlmStub;
let services: FakeServices;
beforeAll(async () => {
  stub = await startLlmStub();
});
afterAll(async () => {
  await stub.close();
});
beforeEach(() => {
  stub.requests.length = 0;
  services = createFakeServices();
});

function drafter(store = createMemoryAgentStore()) {
  return {
    store,
    drafter: createPolicyDrafter({
      llm: createLlm({
        baseUrl: stub.baseUrl,
        apiKey: 'k',
        model: 'm',
        timeoutMs: 1000,
        maxRetries: 0,
      }),
      services,
      store,
    }),
  };
}

const TREASURER = FAKE_PARTIES.treasurer.partyId;

describe('policy drafter', () => {
  it('maps the demo prompt to the documented fields and saves an agent draft', async () => {
    stub.script({
      toolCalls: [
        {
          name: 'draft_policy',
          arguments: {
            cap: '5000',
            approvalThreshold: 2,
            approverNames: ['Approver 1', 'Approver 2', 'Approver 3'],
            scheduleCron: '0 9 1 * *',
          },
        },
      ],
    });
    const { drafter: d } = drafter();
    const draft = await d.draftPolicy(DEMO_PROMPT, TREASURER);

    expect(draft.source).toBe('agent');
    expect(draft.fields).toEqual({
      cap: '5000',
      approvers: [
        FAKE_PARTIES.approver1.partyId,
        FAKE_PARTIES.approver2.partyId,
        FAKE_PARTIES.approver3.partyId,
      ],
      approvalThreshold: 2,
      scheduleCron: '0 9 1 * *',
      scheduleTimezone: 'UTC',
      recordDateRule: 'last_day_of_previous_month',
      fixedAmount: null,
      deviationPct: '50',
      trailingCycles: 3,
      unitChangePct: '100',
      unitChangeWindowDays: 3,
      feeBuffer: '1',
    });
    // One call to the model, forced tool, and only the draft was written: no seal, no other write.
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]?.tool_choice).toEqual({
      type: 'function',
      function: { name: 'draft_policy' },
    });
    expect(services.writes().map((c) => c.method)).toEqual(['policy.saveDraft']);
    // The demo prompt reaches the model as the user message.
    expect(stub.requests[0]?.messages.at(-1)?.content).toBe(DEMO_PROMPT);
  });

  it('uses the approvers of the sealed Mandate when the prompt names none', async () => {
    stub.script({
      toolCalls: [
        {
          name: 'draft_policy',
          arguments: { cap: '5000', approvalThreshold: 2, scheduleCron: '0 9 1 * *' },
        },
      ],
    });
    const draft = await drafter().drafter.draftPolicy(DEMO_PROMPT, TREASURER);
    expect(draft.fields.approvers).toHaveLength(3);
  });

  it('rejects invalid fields: nothing is saved and the treasurer is told to use the form', async () => {
    const cases: Record<string, unknown>[] = [
      { cap: 'five thousand', approvalThreshold: 2, scheduleCron: '0 9 1 * *' },
      { cap: '5000', approvalThreshold: 0, scheduleCron: '0 9 1 * *' },
      { cap: '5000', approvalThreshold: 2, scheduleCron: 'every first' },
      { cap: '5000', approvalThreshold: 2, scheduleCron: '0 9 1 * *', recordDateRule: 'whenever' },
      { cap: '5000', approvalThreshold: 2, scheduleCron: '0 9 1 * *', sealMandate: true },
    ];
    for (const args of cases) {
      stub.script({ toolCalls: [{ name: 'draft_policy', arguments: args }] });
      const { drafter: d, store } = drafter();
      await expect(d.draftPolicy(DEMO_PROMPT, TREASURER)).rejects.toMatchObject({
        status: 422,
        code: 'llm_invalid_output',
      });
      expect(store.events.map((e) => e.kind)).toEqual(['llm_invalid_output']);
    }
    expect(services.writes()).toEqual([]);
  });

  it('rejects unknown approver names and a threshold above the approver count', async () => {
    stub.script({
      toolCalls: [
        {
          name: 'draft_policy',
          arguments: {
            cap: '5000',
            approvalThreshold: 2,
            approverNames: ['Mr X'],
            scheduleCron: '0 9 1 * *',
          },
        },
      ],
    });
    await expect(drafter().drafter.draftPolicy(DEMO_PROMPT, TREASURER)).rejects.toMatchObject({
      status: 422,
      code: 'policy_incomplete',
    });
    stub.script({
      toolCalls: [
        {
          name: 'draft_policy',
          arguments: {
            cap: '5000',
            approvalThreshold: 3,
            approverNames: ['Approver 1', 'Approver 2'],
            scheduleCron: '0 9 1 * *',
          },
        },
      ],
    });
    await expect(drafter().drafter.draftPolicy(DEMO_PROMPT, TREASURER)).rejects.toMatchObject({
      status: 422,
    });
    expect(services.writes()).toEqual([]);
  });

  it('answers 503 llm_unavailable with the reason when the model is down (A11)', async () => {
    stub.always({ status: 500 });
    const { drafter: d, store } = drafter();
    await expect(d.draftPolicy(DEMO_PROMPT, TREASURER)).rejects.toMatchObject({
      status: 503,
      code: 'llm_unavailable',
      message:
        "The agent can't draft right now (500 from the model provider). Fill in the policy form yourself; nothing was changed.",
    });
    expect(services.writes()).toEqual([]);
    expect(store.events.map((e) => e.kind)).toEqual(['llm_unavailable']);
  });

  it('fails when the model does not call the tool or sends broken JSON', async () => {
    for (const step of [
      { text: 'I would pay monthly.' },
      { toolCalls: [{ name: 'draft_policy', arguments: '{oops' }] },
    ]) {
      stub.always(step);
      await expect(drafter().drafter.draftPolicy(DEMO_PROMPT, TREASURER)).rejects.toMatchObject({
        status: 422,
      });
    }
  });
});
