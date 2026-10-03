import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startLlmStub, type LlmStub } from '../../test/llm-stub/server';
import {
  createLlm,
  LlmInvalidOutputError,
  LlmUnavailableError,
  type LlmChatInput,
  type LlmConfig,
} from './client';
import { canonicalJson, fingerprintOf } from './fingerprint';

const TOOL = {
  name: 'get_balance',
  description: 'Read the balance',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};

const INPUT: LlmChatInput = {
  purpose: 'test',
  messages: [
    { role: 'system', content: 'You are a test.' },
    { role: 'user', content: 'Hello' },
  ],
  tools: [TOOL],
};

let stub: LlmStub;

function config(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    baseUrl: stub.baseUrl,
    apiKey: 'test-key',
    model: 'test-model',
    timeoutMs: 2000,
    maxRetries: 0,
    ...overrides,
  };
}

beforeAll(async () => {
  stub = await startLlmStub();
});
afterAll(async () => {
  await stub.close();
});
beforeEach(() => {
  stub.requests.length = 0;
  stub.script({ text: 'OK' });
});

describe('canonical JSON fingerprints', () => {
  it('ignores key order and is a 64 character SHA-256 hex', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}',
    );
    expect(fingerprintOf({ a: 1, b: 2 })).toBe(fingerprintOf({ b: 2, a: 1 }));
    expect(fingerprintOf({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintOf({ a: 1 })).not.toBe(fingerprintOf({ a: 2 }));
  });
});

describe('createLlm', () => {
  it('returns text and the tool calls of the model with the raw argument text', async () => {
    stub.script({
      text: 'Checking.',
      toolCalls: [{ name: 'get_balance', arguments: { x: 1 }, id: 'call_1' }],
    });
    const turn = await createLlm(config()).chat(INPUT);
    expect(turn.toolCalls).toEqual([{ id: 'call_1', name: 'get_balance', arguments: '{"x":1}' }]);
    expect(turn.message.content).toBe('Checking.');
    expect(turn.message.tool_calls?.[0]?.function.name).toBe('get_balance');
  });

  it('throws LlmInvalidOutputError naming the type of a tool call that is not a function call', async () => {
    stub.script({ toolCalls: [{ name: 'get_balance', arguments: {}, type: 'custom' }] });
    const failure = await createLlm(config())
      .chat(INPUT)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LlmInvalidOutputError);
    expect((failure as Error).message).toContain('"custom"');
  });

  it('sends model, messages, tools, tool_choice and parallel_tool_calls: false', async () => {
    await createLlm(config()).chat({ ...INPUT, toolChoice: { name: 'get_balance' } });
    const sent = stub.requests[0];
    expect(sent?.model).toBe('test-model');
    expect(sent?.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(sent?.tools?.[0]?.function.name).toBe('get_balance');
    expect(sent?.tools?.[0]?.function.strict).toBeUndefined();
    expect(sent?.tool_choice).toEqual({ type: 'function', function: { name: 'get_balance' } });
    expect(sent?.parallel_tool_calls).toBe(false);
  });

  it('sends strict: true on function tools only when LLM_STRICT_TOOLS is on', async () => {
    await createLlm(config({ strictTools: true })).chat(INPUT);
    expect(stub.requests[0]?.tools?.[0]?.function.strict).toBe(true);
  });

  it('leaves tools out when there are none', async () => {
    await createLlm(config()).chat({ purpose: 'plain', messages: INPUT.messages });
    expect(stub.requests[0]?.tools).toBeUndefined();
    expect(stub.requests[0]?.parallel_tool_calls).toBeUndefined();
  });

  it('A12: fingerprints are SHA-256 hex, stable for identical requests and different for different ones', async () => {
    const llm = createLlm(config());
    stub.always({ text: 'same answer' });
    const a = await llm.chat(INPUT);
    const b = await llm.chat(INPUT);
    expect(a.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(a.requestFingerprint).toBe(b.requestFingerprint);
    expect(a.responseFingerprint).toBe(b.responseFingerprint);
    const c = await llm.chat({
      ...INPUT,
      messages: [...INPUT.messages, { role: 'user', content: 'More' }],
    });
    expect(c.requestFingerprint).not.toBe(a.requestFingerprint);
    stub.always({ text: 'another answer' });
    const d = await llm.chat(INPUT);
    expect(d.requestFingerprint).toBe(a.requestFingerprint);
    expect(d.responseFingerprint).not.toBe(a.responseFingerprint);
  });

  it('the request fingerprint covers what the model is shown', async () => {
    stub.always({ text: 'x' });
    const llm = createLlm(config());
    const withTool = await llm.chat(INPUT);
    const withoutTool = await llm.chat({ purpose: 'test', messages: INPUT.messages });
    expect(withTool.requestFingerprint).not.toBe(withoutTool.requestFingerprint);
    const other = await createLlm(config({ model: 'other-model' })).chat(INPUT);
    expect(other.requestFingerprint).not.toBe(withTool.requestFingerprint);
  });

  it('turns a 500 into LlmUnavailableError with the status as the reason', async () => {
    stub.always({ status: 500 });
    await expect(createLlm(config()).chat(INPUT)).rejects.toMatchObject({
      name: 'LlmUnavailableError',
      reason: '500 from the model provider',
    });
  });

  it('turns a 401 into LlmUnavailableError', async () => {
    stub.always({ status: 401 });
    await expect(createLlm(config()).chat(INPUT)).rejects.toMatchObject({
      reason: '401 from the model provider',
    });
  });

  it('turns a timeout into LlmUnavailableError with the time in the reason', async () => {
    stub.always({ delayMs: 1500, then: { text: 'late' } });
    const error = await createLlm(config({ timeoutMs: 200 }))
      .chat(INPUT)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmUnavailableError);
    expect((error as LlmUnavailableError).reason).toBe('timed out after 0.2 s');
  });

  it('turns a connection that nothing listens on into LlmUnavailableError', async () => {
    const dead = await startLlmStub();
    const baseUrl = dead.baseUrl;
    await dead.close();
    const error = await createLlm(config({ baseUrl }))
      .chat(INPUT)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmUnavailableError);
    expect((error as LlmUnavailableError).reason).toBe('model provider unreachable');
  });

  it('treats an answer without choices as unavailable', async () => {
    stub.always({ empty: true });
    await expect(createLlm(config()).chat(INPUT)).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it('retries once on a 500 by default (maxRetries: 1)', async () => {
    stub.script({ status: 500 }, { text: 'recovered' });
    const turn = await createLlm({ ...config(), maxRetries: undefined }).chat(INPUT);
    expect(turn.message.content).toBe('recovered');
    expect(stub.requests).toHaveLength(2);
  });
});
