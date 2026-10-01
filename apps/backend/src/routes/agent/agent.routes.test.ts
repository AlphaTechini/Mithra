import type {
  AgentConversation,
  PolicyDraft,
  Role,
  SendAgentMessageResponse,
} from '@mithra/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import '../../auth/plugin';
import type { AuditScopeResult } from '../../audit/scope';
import { ApiError, errorBody } from '../../http/errors';
import { agentRoutes } from './index';

const ROLES: Record<string, Role[]> = {
  'treasurer::1': ['treasurer'],
  'approver::1': ['approver'],
  'holder::1': ['holder'],
  'auditor::1': ['auditor'],
};

interface Calls {
  respond: { partyId: string; roles: readonly Role[]; text: string }[];
  draft: { prompt: string; party: string }[];
  scope: string[];
}

async function build(limit = 20): Promise<{ app: FastifyInstance; calls: Calls }> {
  const calls: Calls = { respond: [], draft: [], scope: [] };
  const message = (role: 'user' | 'assistant', text: string) => ({
    id: String(calls.respond.length),
    role,
    text,
    actions: [],
    at: '2026-10-01T09:00:00.000Z',
    degraded: false,
  });
  const app = Fastify({ logger: false });
  app.decorateRequest('session', null);
  app.decorate('roleResolver', {
    resolveRoles: (id: string) =>
      Promise.resolve({ roles: ROLES[id] ?? [], primaryRole: ROLES[id]?.[0] ?? null }),
    resolveMany: () => Promise.resolve(new Map()),
  });
  app.addHook('onRequest', (request, _reply, done) => {
    const party = request.headers['x-party'];
    request.session = typeof party === 'string' ? { id: 's', partyId: party } : null;
    done();
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError)
      return reply.code(error.status).send(errorBody(error.code, error.message));
    return reply.code(500).send(errorBody('internal_error', 'Internal server error'));
  });
  agentRoutes(app, {
    messageLimit: { limit, windowMs: 60_000 },
    agent: {
      respond(input): Promise<SendAgentMessageResponse> {
        calls.respond.push(input);
        return Promise.resolve({
          user: message('user', input.text),
          reply: message('assistant', 'ok'),
        });
      },
      conversation(): Promise<AgentConversation> {
        return Promise.resolve({
          messages: [],
          suggestions: ['Distribute 1,200 CC for September.'],
        });
      },
    },
    drafter: {
      draftPolicy(prompt, party): Promise<PolicyDraft> {
        calls.draft.push({ prompt, party });
        if (prompt === 'fail') {
          return Promise.reject(
            new ApiError(503, 'llm_unavailable', "The agent can't draft right now (x)."),
          );
        }
        return Promise.resolve({
          draftId: 'd',
          fields: {} as PolicyDraft['fields'],
          summary: 's',
          agentCan: [],
          agentCannot: [],
          source: 'agent',
          updatedAt: '2026-10-01T09:00:00.000Z',
        });
      },
    },
    scope: {
      draft(question): Promise<AuditScopeResult> {
        calls.scope.push(question);
        return Promise.resolve({ items: [], excluded: 'x', source: 'rules' });
      },
    },
  });
  await app.ready();
  return { app, calls };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const as = (party: string) => ({ 'x-party': party });

describe('agent routes', () => {
  it('GET /api/agent/messages: treasurer and approver only, signed in', async () => {
    const built = await build();
    app = built.app;
    expect((await app.inject({ method: 'GET', url: '/api/agent/messages' })).statusCode).toBe(401);
    for (const party of ['holder::1', 'auditor::1']) {
      const denied = await app.inject({
        method: 'GET',
        url: '/api/agent/messages',
        headers: as(party),
      });
      expect(denied.statusCode, party).toBe(403);
    }
    for (const party of ['treasurer::1', 'approver::1']) {
      const ok = await app.inject({
        method: 'GET',
        url: '/api/agent/messages',
        headers: as(party),
      });
      expect(ok.statusCode, party).toBe(200);
      expect(ok.json<AgentConversation>().suggestions).toHaveLength(1);
    }
  });

  it("POST /api/agent/messages: validates the body and passes the caller's party and roles", async () => {
    const built = await build();
    app = built.app;
    const bad = await app.inject({
      method: 'POST',
      url: '/api/agent/messages',
      headers: as('treasurer::1'),
      payload: { text: '   ' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: { code: 'invalid_request' } });
    const tooLong = await app.inject({
      method: 'POST',
      url: '/api/agent/messages',
      headers: as('treasurer::1'),
      payload: { text: 'x'.repeat(2001) },
    });
    expect(tooLong.statusCode).toBe(400);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/agent/messages',
      headers: as('approver::1'),
      payload: { text: ' Why was it flagged? ' },
    });
    expect(ok.statusCode).toBe(200);
    expect(built.calls.respond).toEqual([
      { partyId: 'approver::1', roles: ['approver'], text: 'Why was it flagged?' },
    ]);
    const holder = await app.inject({
      method: 'POST',
      url: '/api/agent/messages',
      headers: as('holder::1'),
      payload: { text: 'hi' },
    });
    expect(holder.statusCode).toBe(403);
  });

  it('rate limits messages per party (20 per minute)', async () => {
    const built = await build(3);
    app = built.app;
    const send = (party: string) =>
      app!.inject({
        method: 'POST',
        url: '/api/agent/messages',
        headers: as(party),
        payload: { text: 'hi' },
      });
    expect((await send('treasurer::1')).statusCode).toBe(200);
    expect((await send('treasurer::1')).statusCode).toBe(200);
    expect((await send('treasurer::1')).statusCode).toBe(200);
    const limited = await send('treasurer::1');
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: 'too_many_requests' } });
    // Another party has its own allowance.
    expect((await send('approver::1')).statusCode).toBe(200);
  });

  it('defaults to 20 messages per minute per party', async () => {
    const built = await build();
    app = built.app;
    let last = 0;
    for (let i = 0; i < 21; i += 1) {
      last = (
        await app.inject({
          method: 'POST',
          url: '/api/agent/messages',
          headers: as('treasurer::1'),
          payload: { text: 'hi' },
        })
      ).statusCode;
    }
    expect(last).toBe(429);
    expect(built.calls.respond).toHaveLength(20);
  });

  it('POST /api/policy/draft: treasurer only; passes the prompt; relays 503 with the reason', async () => {
    const built = await build();
    app = built.app;
    const denied = await app.inject({
      method: 'POST',
      url: '/api/policy/draft',
      headers: as('approver::1'),
      payload: { prompt: 'x' },
    });
    expect(denied.statusCode).toBe(403);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/policy/draft',
      headers: as('treasurer::1'),
      payload: { prompt: '' },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/policy/draft',
      headers: as('treasurer::1'),
      payload: { prompt: 'Pay monthly' },
    });
    expect(ok.statusCode).toBe(200);
    expect(built.calls.draft).toEqual([{ prompt: 'Pay monthly', party: 'treasurer::1' }]);
    const down = await app.inject({
      method: 'POST',
      url: '/api/policy/draft',
      headers: as('treasurer::1'),
      payload: { prompt: 'fail' },
    });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toEqual({
      error: { code: 'llm_unavailable', message: "The agent can't draft right now (x)." },
    });
  });

  it('POST /api/audit/scope/draft: auditor or treasurer', async () => {
    const built = await build();
    app = built.app;
    for (const party of ['auditor::1', 'treasurer::1']) {
      const ok = await app.inject({
        method: 'POST',
        url: '/api/audit/scope/draft',
        headers: as(party),
        payload: { question: 'Show Q3' },
      });
      expect(ok.statusCode, party).toBe(200);
      expect(ok.json()).toEqual({ items: [], excluded: 'x', source: 'rules' });
    }
    for (const party of ['approver::1', 'holder::1']) {
      const denied = await app.inject({
        method: 'POST',
        url: '/api/audit/scope/draft',
        headers: as(party),
        payload: { question: 'Show Q3' },
      });
      expect(denied.statusCode, party).toBe(403);
    }
    const bad = await app.inject({
      method: 'POST',
      url: '/api/audit/scope/draft',
      headers: as('auditor::1'),
      payload: {},
    });
    expect(bad.statusCode).toBe(400);
    expect(built.calls.scope).toEqual(['Show Q3', 'Show Q3']);
  });
});
