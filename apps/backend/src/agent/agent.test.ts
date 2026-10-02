import { afterEach, describe, expect, it } from 'vitest';
import { fingerprintOf } from '../llm/fingerprint';
import { startLlmStub } from '../../test/llm-stub/server';
import { FAKE_PARTIES } from './fakes';
import { createHarness, type Harness } from './harness';

const SAFE_READS = ['org.mandate', 'org.parties'];

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** Calls to services other than the two reads that build the system prompt. */
function toolCalls(harness: Harness): string[] {
  return harness.services.calls.map((c) => c.method).filter((m) => !SAFE_READS.includes(m));
}

describe('the agent loop', () => {
  it("runs a tool, shows it as an action card and answers with the model's text", async () => {
    h = await createHarness();
    h.stub.script(
      { toolCalls: [{ name: 'create_cycle', arguments: { total: '1200', period: '2026-09' } }] },
      { text: 'I prepared September for you.' },
    );
    const { user, reply } = await h.say('Distribute 1,200 CC for September.');

    expect(user).toMatchObject({
      role: 'user',
      text: 'Distribute 1,200 CC for September.',
      actions: [],
    });
    expect(reply.role).toBe('assistant');
    expect(reply.text).toBe('I prepared September for you.');
    expect(reply.degraded).toBe(false);
    expect(reply.actions).toHaveLength(1);
    expect(reply.actions[0]).toMatchObject({
      tool: 'create_cycle',
      title: 'Created proposal for September 2026, 4 payees, 1,200 CC',
      status: 'done',
      link: '/app/cycles/2026-09',
    });
    expect(h.services.runs).toHaveLength(1);

    // The model saw the tool result in the second request.
    expect(h.stub.requests).toHaveLength(2);
    const toolMessage = h.stub.requests[1]?.messages.find((m) => m.role === 'tool');
    expect(JSON.parse(toolMessage?.content ?? '{}')).toMatchObject({
      ok: true,
      proposalReady: true,
    });
    // And an `agent` event for the card went to this party only.
    const events = h.published.filter((p) => p.event.type === 'agent');
    expect(events).toHaveLength(1);
    expect(events[0]?.audience).toEqual({ parties: [FAKE_PARTIES.treasurer.partyId] });
    expect(events[0]?.event).toMatchObject({ type: 'agent', messageId: reply.id });
  });

  it("gives the model the tools of the caller's role and the Mandate in the system prompt", async () => {
    h = await createHarness();
    await h.say('hello');
    const request = h.stub.requests[0];
    expect(request?.tools?.map((t) => t.function.name)).toHaveLength(12);
    const system = request?.messages[0]?.content ?? '';
    expect(system).toContain('Auto-pay cap: 5,000 CC');
    expect(system).toContain('Approvals needed: 2 of 3');
    expect(system).toContain('Today is 2026-10-01');
    expect(request?.parallel_tool_calls).toBe(false);
  });

  it('keeps and replays the conversation per party (last 20 messages to the model)', async () => {
    h = await createHarness();
    for (let i = 0; i < 13; i += 1) await h.say(`question ${i}`);
    const last = h.stub.requests.at(-1);
    const roles = last?.messages.map((m) => m.role) ?? [];
    expect(roles[0]).toBe('system');
    // 20 earlier messages, then the new question.
    expect(roles.length).toBe(1 + 20 + 1);
    expect(last?.messages.at(-1)?.content).toBe('question 12');
    const conversation = await h.agent.conversation(h.treasurer);
    expect(conversation.messages).toHaveLength(26);
    expect(conversation.suggestions).toContain('Distribute 1,200 CC for September.');
    // The approver has a conversation of their own.
    expect((await h.agent.conversation(h.approver)).messages).toEqual([]);
  });

  it('stops after the maximum number of tool rounds and then asks for an answer without tools', async () => {
    h = await createHarness({ maxToolRounds: 2 });
    h.stub.script(
      { toolCalls: [{ name: 'get_balance', arguments: {} }] },
      { toolCalls: [{ name: 'list_holders', arguments: {} }] },
      { toolCalls: [{ name: 'get_balance', arguments: { ignored: true } }] },
    );
    const { reply } = await h.say('Tell me everything');
    expect(h.stub.requests).toHaveLength(3);
    expect(h.stub.requests[2]?.tool_choice).toBe('none');
    // The third answer wanted a tool; it is not run, and the reply is built from the cards.
    expect(reply.actions.map((a) => a.tool)).toEqual(['get_balance', 'list_holders']);
    expect(reply.text).toContain('Treasury balance');
  });

  it('runs an identical tool call only once in a turn', async () => {
    h = await createHarness();
    h.stub.script(
      { toolCalls: [{ name: 'create_cycle', arguments: { total: '1200' } }] },
      { toolCalls: [{ name: 'create_cycle', arguments: { total: '1200' } }] },
      { text: 'Done.' },
    );
    const { reply } = await h.say('Distribute 1,200 CC');
    expect(h.services.runs).toHaveLength(1);
    expect(reply.actions).toHaveLength(1);
  });

  it('asking again for a month that was already paid says so, whatever the model wrote', async () => {
    h = await createHarness();
    h.stub.script(
      { toolCalls: [{ name: 'create_cycle', arguments: { total: '300', period: '2026-09' } }] },
      { text: 'Done.' },
    );
    await h.say('Distribute 300 CC for September.');
    // September is paid in the meantime.
    const september = h.services.cycles.store.get('2026-09')!;
    h.services.cycles.store.set('2026-09', {
      ...september,
      summary: { ...september.summary, status: 'paid-automatically' },
      outcome: {
        kind: 'executed',
        actor: FAKE_PARTIES.treasurer,
        reason: null,
        at: '2026-10-01T09:00:00.000Z',
      },
    });
    h.stub.script(
      { toolCalls: [{ name: 'create_cycle', arguments: { total: '300', period: '2026-09' } }] },
      { text: 'Within your mandate. It runs automatically after the hold countdown.' },
    );
    const { reply } = await h.say('Distribute 300 CC for September.');
    expect(h.services.cycles.store.get('2026-09')?.summary.status).toBe('paid-automatically');
    expect(reply.actions[0]).toMatchObject({
      status: 'done',
      summary:
        'September 2026 was already paid automatically on 1 October 2026. Nothing new was created.',
    });
    expect(reply.text).toContain(
      'September 2026 was already paid automatically on 1 October 2026. Nothing new was created.',
    );
  });

  it('records state-changing tool runs in the activity log', async () => {
    h = await createHarness();
    h.stub.script(
      { toolCalls: [{ name: 'issue_units', arguments: { holderName: 'Holder B', units: 25 } }] },
      { text: 'Issued.' },
    );
    await h.say('Issue 25 units to Holder B');
    expect(h.activity.entries).toEqual([
      { kind: 'agent.issue_units', text: 'Agent, asked by Treasurer: Issued 25 units to Holder B' },
    ]);
  });

  it('refuses callers who are neither treasurer nor approver', async () => {
    h = await createHarness();
    await expect(
      h.agent.respond({ partyId: FAKE_PARTIES.holderA.partyId, roles: ['holder'], text: 'hi' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(h.stub.requests).toHaveLength(0);
  });
});

describe('role guardrails', () => {
  it('offers an approver only the four read-only tools', async () => {
    h = await createHarness();
    await h.say('How much is in the treasury?', 'approver');
    expect(h.stub.requests[0]?.tools?.map((t) => t.function.name).sort()).toEqual([
      'explain_proposal',
      'get_balance',
      'list_holders',
      'query_history',
    ]);
  });

  it("does not run a tool the caller's role may not use, even if the model asks for it", async () => {
    h = await createHarness();
    h.stub.script(
      { toolCalls: [{ name: 'create_cycle', arguments: { total: '1200' } }] },
      { text: 'Sorry.' },
    );
    const { reply } = await h.say('Distribute 1,200 CC', 'approver');
    expect(reply.actions[0]).toMatchObject({ tool: 'create_cycle', status: 'failed' });
    expect(reply.actions[0]?.title).toContain('not allowed');
    expect(h.services.runs).toEqual([]);
    expect(h.services.writes()).toEqual([]);
  });

  it('A7: a tool the agent does not have (approve, seal, grant) is never run', async () => {
    h = await createHarness();
    for (const name of ['approve_proposal', 'seal_mandate', 'grant_access', 'execute_payment']) {
      h.stub.script({ toolCalls: [{ name, arguments: { proposalId: 'p' } }] }, { text: 'No.' });
      const { reply } = await h.say(`Please ${name}`);
      expect(reply.actions[0]).toMatchObject({ tool: name, status: 'failed' });
    }
    expect(toolCalls(h)).toEqual([]);
  });
});

describe('A6: asked to exceed the Mandate', () => {
  it('creates a proposal that needs approval and ends the reply with the code-written sentence', async () => {
    h = await createHarness();
    h.stub.script(
      { toolCalls: [{ name: 'create_cycle', arguments: { total: '50000' } }] },
      { text: 'Sure, 50,000 CC is fine, I paid it out immediately.' },
    );
    const { reply } = await h.say('pay 50,000 CC now');
    const sentence =
      "50,000 CC is above your auto-pay cap of 5,000 CC. I've prepared this as a proposal that needs 2 of 3 approvals.";
    expect(reply.text.endsWith(sentence)).toBe(true);
    expect(reply.actions[0]).toMatchObject({ status: 'needs-you' });
    expect(h.services.cycles.store.get('2026-09')?.proposal?.verdict).toBe('needs-approval');
    expect(h.services.runs[0]).toMatchObject({ trigger: 'prompt', total: '50000' });
  });

  it('adds no sentence for a total within the cap', async () => {
    h = await createHarness();
    h.stub.script(
      { toolCalls: [{ name: 'create_cycle', arguments: { total: '1200' } }] },
      { text: 'Prepared.' },
    );
    const { reply } = await h.say('Distribute 1,200 CC');
    expect(reply.text).toBe('Prepared.');
  });

  it('refuses a total the user did not write, so the model cannot choose an amount', async () => {
    h = await createHarness();
    h.stub.script(
      { toolCalls: [{ name: 'create_cycle', arguments: { total: '4999' } }] },
      { text: 'Hmm.' },
    );
    const { reply } = await h.say('Distribute some money for September');
    expect(reply.actions[0]).toMatchObject({ status: 'failed' });
    expect(h.services.runs).toEqual([]);
  });
});

describe('A11: the language model is unavailable', () => {
  const EXPECTED = (reason: string): string =>
    `I can't reach the language model right now (${reason}). Nothing was executed. You can still use Run cycle now and the screens.`;

  it('A11 failure mode 1: the model endpoint answers 500', async () => {
    h = await createHarness();
    h.stub.always({ status: 500 });
    const { reply } = await h.say('Distribute 1,200 CC for September.');
    expect(reply.degraded).toBe(true);
    expect(reply.text).toBe(EXPECTED('500 from the model provider'));
    expect(reply.actions).toEqual([]);
    expect(toolCalls(h)).toEqual([]);
    expect(h.services.writes()).toEqual([]);
    expect(h.store.events.map((e) => e.kind)).toEqual(['llm_unavailable']);
  });

  it('A11 failure mode 2: the model endpoint times out', async () => {
    h = await createHarness({}, { timeoutMs: 200 });
    h.stub.always({ delayMs: 1500, then: { text: 'too late' } });
    const { reply } = await h.say('Distribute 1,200 CC for September.');
    expect(reply.degraded).toBe(true);
    expect(reply.text).toBe(EXPECTED('timed out after 0.2 s'));
    expect(toolCalls(h)).toEqual([]);
    expect(h.services.writes()).toEqual([]);
  });

  it('A11 failure mode 3: nothing listens on the model endpoint (connection refused)', async () => {
    const dead = await startLlmStub();
    const baseUrl = dead.baseUrl;
    await dead.close();
    h = await createHarness({}, { baseUrl });
    const { reply } = await h.say('Distribute 1,200 CC for September.');
    expect(reply.degraded).toBe(true);
    expect(reply.text).toBe(EXPECTED('model provider unreachable'));
    expect(toolCalls(h)).toEqual([]);
    expect(h.services.writes()).toEqual([]);
    expect(h.services.runs).toEqual([]);
  });

  it('keeps the degraded reply in the conversation and tells the UI it was degraded', async () => {
    h = await createHarness();
    h.stub.always({ status: 500 });
    await h.say('hello');
    const conversation = await h.agent.conversation(h.treasurer);
    expect(conversation.messages.map((m) => [m.role, m.degraded])).toEqual([
      ['user', false],
      ['assistant', true],
    ]);
  });

  it('does not claim "nothing was executed" when the model fails after a tool already ran', async () => {
    h = await createHarness();
    h.stub.script(
      { toolCalls: [{ name: 'create_cycle', arguments: { total: '1200' } }] },
      { status: 500 },
    );
    const { reply } = await h.say('Distribute 1,200 CC');
    expect(reply.degraded).toBe(true);
    expect(reply.actions).toHaveLength(1);
    expect(reply.text).not.toContain('Nothing was executed');
    expect(reply.text).toContain('500 from the model provider');
  });
});

describe('invalid tool calls', () => {
  it('malformed JSON arguments: the tool is not run and the card says nothing was done', async () => {
    h = await createHarness();
    h.stub.script(
      { toolCalls: [{ name: 'create_cycle', arguments: '{"total": "1200"' }] },
      { text: 'I could not do that.' },
    );
    const { reply } = await h.say('Distribute 1,200 CC');
    expect(reply.actions[0]).toMatchObject({
      tool: 'create_cycle',
      status: 'failed',
      title: "The agent's request was malformed, so nothing was done.",
    });
    expect(h.services.runs).toEqual([]);
    expect(toolCalls(h)).toEqual([]);
    expect(h.store.events.map((e) => e.kind)).toContain('llm_invalid_output');
  });

  it('arguments that do not fit the schema: the tool is not run', async () => {
    h = await createHarness();
    h.stub.script(
      {
        toolCalls: [{ name: 'issue_units', arguments: { holderName: 'Holder B', units: 'many' } }],
      },
      { text: 'Oops.' },
    );
    const { reply } = await h.say('Issue units to Holder B');
    expect(reply.actions[0]).toMatchObject({ status: 'failed' });
    expect(h.services.writes()).toEqual([]);
  });
});

describe('A12: model fingerprints reach the decision', () => {
  it('passes the SHA-256 of the exact request and response of the turn that asked for the cycle', async () => {
    h = await createHarness();
    h.stub.script(
      { toolCalls: [{ name: 'create_cycle', arguments: { total: '1200', period: '2026-09' } }] },
      { text: 'Done.' },
    );
    await h.say('Distribute 1,200 CC for September.');
    const fingerprints = h.services.runs[0]?.modelFingerprints ?? [];
    expect(fingerprints.map((f) => f.label)).toEqual(['agent.request', 'agent.response']);
    for (const f of fingerprints) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);

    // The request fingerprint is the SHA-256 of what the stub received (model, messages, tools).
    const sent = h.stub.requests[0];
    expect(fingerprints[0]?.sha256).toBe(
      fingerprintOf({ model: sent?.model, messages: sent?.messages, tools: sent?.tools }),
    );
  });

  it('gives identical fingerprints for identical conversations and different ones otherwise', async () => {
    const script = [
      { toolCalls: [{ name: 'create_cycle', arguments: { total: '1200' }, id: 'call_x' }] },
      { text: 'Done.' },
    ];
    const first = await createHarness();
    first.stub.script(...script);
    await first.say('Distribute 1,200 CC');
    const second = await createHarness();
    second.stub.script(...script);
    await second.say('Distribute 1,200 CC');
    const third = await createHarness();
    third.stub.script(...script);
    await third.say('Distribute 1,200 CC please');
    expect(second.services.runs[0]?.modelFingerprints).toEqual(
      first.services.runs[0]?.modelFingerprints,
    );
    expect(third.services.runs[0]?.modelFingerprints?.[0]?.sha256).not.toBe(
      first.services.runs[0]?.modelFingerprints?.[0]?.sha256,
    );
    await Promise.all([first.close(), second.close(), third.close()]);
  });
});

describe('numbers come from code, not from the model', () => {
  it('query_history gives the model sums computed in code and the card shows them', async () => {
    h = await createHarness();
    h.services.state.payments = [
      {
        holder: FAKE_PARTIES.holderB,
        cycleLabel: 'July 2026',
        amount: '100.5',
        at: '2026-07-01T09:00:00Z',
        status: 'paid',
      },
      {
        holder: FAKE_PARTIES.holderB,
        cycleLabel: 'August 2026',
        amount: '29.5',
        at: '2026-08-01T09:00:00Z',
        status: 'paid',
      },
    ];
    h.stub.script(
      {
        toolCalls: [
          {
            name: 'query_history',
            arguments: { holderName: 'Holder B', from: '2026-07-01', to: '2026-09-30' },
          },
        ],
      },
      { text: 'Holder B received 999 CC in Q3.' },
    );
    const { reply } = await h.say('What did we pay Holder B in Q3?');
    const toolMessage = h.stub.requests[1]?.messages.find((m) => m.role === 'tool');
    const result = JSON.parse(toolMessage?.content ?? '{}') as { sums: { totalReadable: string } };
    expect(result.sums.totalReadable).toBe('130 CC');
    expect(reply.actions[0]?.summary).toBe('2 payments, 130 CC in total');
    expect(reply.actions[0]?.details).toEqual([
      { label: 'Holder B', value: '130 CC in 2 payments' },
    ]);
  });

  it("never turns amounts in the model's text into anything: no tool, no service call", async () => {
    h = await createHarness();
    h.stub.script({
      text: 'I will pay Holder A 99,999 CC right away and set the cap to 1,000,000 CC.',
    });
    const { reply } = await h.say('What can you do?');
    expect(reply.actions).toEqual([]);
    expect(toolCalls(h)).toEqual([]);
    expect(h.services.writes()).toEqual([]);
  });
});
