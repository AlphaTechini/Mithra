import type { ActivityEntry, Role } from '@mithra/shared';
import { EventBus, type Published } from '../events/bus';
import { createLlm } from '../llm/client';
import { startLlmStub, type LlmStub } from '../../test/llm-stub/server';
import { createAgent, type Agent, type AgentDeps } from './agent';
import { createFakeServices, fakeNames, FAKE_PARTIES, type FakeServices } from './fakes';
import { createMemoryAgentStore } from './store';

/** Everything an agent test needs: a stub model, fake services, an in-memory store. Not used by the app. */
export interface Harness {
  stub: LlmStub;
  services: FakeServices;
  store: ReturnType<typeof createMemoryAgentStore>;
  bus: EventBus;
  published: Published[];
  activity: { entries: { kind: string; text: string }[] };
  agent: Agent;
  treasurer: { partyId: string; roles: Role[] };
  approver: { partyId: string; roles: Role[] };
  say(text: string, who?: 'treasurer' | 'approver'): ReturnType<Agent['respond']>;
  close(): Promise<void>;
}

export async function createHarness(
  overrides: Partial<AgentDeps> = {},
  llmOptions: { timeoutMs?: number; baseUrl?: string } = {},
): Promise<Harness> {
  const stub = await startLlmStub();
  const services = createFakeServices();
  const store = createMemoryAgentStore();
  const bus = new EventBus();
  const published: Published[] = [];
  bus.subscribe((p) => published.push(p));
  const activity = { entries: [] as { kind: string; text: string }[] };
  const llm = createLlm({
    baseUrl: llmOptions.baseUrl ?? stub.baseUrl,
    apiKey: 'test',
    model: 'test-model',
    timeoutMs: llmOptions.timeoutMs ?? 1500,
    maxRetries: 0,
  });
  const agent = createAgent({
    llm,
    services,
    names: fakeNames,
    bus,
    store,
    activity: {
      record(input) {
        activity.entries.push({ kind: input.kind, text: input.text });
        return Promise.resolve({ id: '1' } as unknown as ActivityEntry);
      },
    },
    now: () => new Date('2026-10-01T09:00:00Z'),
    proposalWaitMs: 400,
    pollMs: 10,
    ...overrides,
  });
  const treasurer = { partyId: FAKE_PARTIES.treasurer.partyId, roles: ['treasurer'] as Role[] };
  const approver = { partyId: FAKE_PARTIES.approver1.partyId, roles: ['approver'] as Role[] };
  return {
    stub,
    services,
    store,
    bus,
    published,
    activity,
    agent,
    treasurer,
    approver,
    say: (text, who = 'treasurer') =>
      agent.respond({ ...(who === 'treasurer' ? treasurer : approver), text }),
    close: () => stub.close(),
  };
}
