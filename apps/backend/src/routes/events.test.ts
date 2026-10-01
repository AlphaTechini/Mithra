import type { AddressInfo } from 'node:net';
import type { Role } from '@mithra/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import '../auth/plugin';
import { EventBus, TREASURY_TEAM } from '../events/bus';
import { ApiError, errorBody } from '../http/errors';
import { eventsRoute } from './events';

const ROLES: Record<string, Role[]> = {
  'treasurer::1': ['treasurer'],
  'approver::1': ['approver'],
  'holder::1': ['holder'],
  'holder::2': ['holder'],
};

interface Running {
  app: FastifyInstance;
  bus: EventBus;
  url: string;
  active(): number;
}

async function start(heartbeatMs = 20_000, roleRefreshMs?: number): Promise<Running> {
  const bus = new EventBus();
  let active = 0;
  const subscribe = bus.subscribe.bind(bus);
  bus.subscribe = (listener) => {
    active += 1;
    const off = subscribe(listener);
    return () => {
      active -= 1;
      off();
    };
  };
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
  eventsRoute(app, { bus, heartbeatMs, ...(roleRefreshMs === undefined ? {} : { roleRefreshMs }) });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  return { app, bus, url: `http://127.0.0.1:${port}/api/events`, active: () => active };
}

interface Client {
  response: Response;
  controller: AbortController;
  /** Everything read so far. */
  text(): string;
  /** Resolves once `needle` has arrived, or rejects after `ms`. */
  waitFor(needle: string, ms?: number): Promise<void>;
}

async function connect(running: Running, party: string): Promise<Client> {
  const controller = new AbortController();
  const response = await fetch(running.url, {
    headers: { 'x-party': party },
    signal: controller.signal,
  });
  let received = '';
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) return;
        received += decoder.decode(chunk.value as Uint8Array);
      }
    } catch {
      // aborted
    }
  })();
  return {
    response,
    controller,
    text: () => received,
    async waitFor(needle, ms = 1500) {
      const deadline = Date.now() + ms;
      while (!received.includes(needle)) {
        if (Date.now() > deadline)
          throw new Error(`"${needle}" did not arrive; got ${JSON.stringify(received)}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}

let running: Running | undefined;
afterEach(async () => {
  await running?.app.close();
  running = undefined;
});

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150));

describe('GET /api/events', () => {
  it('answers 401 without a session', async () => {
    running = await start();
    const response = await fetch(running.url);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'not_signed_in' } });
  });

  it('streams text/event-stream with no caching, and event:/data: lines', async () => {
    running = await start();
    const client = await connect(running, 'treasurer::1');
    expect(client.response.status).toBe(200);
    expect(client.response.headers.get('content-type')).toContain('text/event-stream');
    expect(client.response.headers.get('cache-control')).toBe('no-store');
    running.bus.publish(
      { type: 'cycle', cycleId: '2026-09', status: 'awaiting-approval' },
      TREASURY_TEAM,
    );
    await client.waitFor('event: cycle\n');
    expect(client.text()).toContain(
      `data: ${JSON.stringify({ type: 'cycle', cycleId: '2026-09', status: 'awaiting-approval' })}\n\n`,
    );
    client.controller.abort();
  });

  it('delivers each client only the events whose audience includes its party or roles', async () => {
    running = await start();
    const treasurer = await connect(running, 'treasurer::1');
    const approver = await connect(running, 'approver::1');
    const holder1 = await connect(running, 'holder::1');
    const holder2 = await connect(running, 'holder::2');
    await settle();

    // Treasury team: treasurer and approver, not holders.
    running.bus.publish({ type: 'cycle', cycleId: 'c1', status: 'running' }, TREASURY_TEAM);
    // Role audience: treasurers only.
    running.bus.publish({ type: 'audit', requestId: 'r1' }, { roles: ['treasurer'] });
    // Party audience: one holder only.
    running.bus.publish({ type: 'holder', change: 'payments' }, { parties: ['holder::1'] });
    // The agent's cards go to the party that asked.
    running.bus.publish(
      {
        type: 'agent',
        messageId: 'm1',
        action: {
          id: 'a',
          tool: 'get_balance',
          title: 'Treasury balance',
          status: 'done',
          summary: null,
          details: [],
          link: null,
        },
      },
      { parties: ['treasurer::1'] },
    );
    await treasurer.waitFor('event: agent');
    await settle();

    const names = (c: Client): string[] =>
      [...c.text().matchAll(/^event: (\w+)$/gm)].map((m) => m[1] ?? '');
    expect(names(treasurer)).toEqual(['cycle', 'audit', 'agent']);
    expect(names(approver)).toEqual(['cycle']);
    expect(names(holder1)).toEqual(['holder']);
    expect(names(holder2)).toEqual([]);
    for (const c of [treasurer, approver, holder1, holder2]) c.controller.abort();
  });

  it('looks the roles up again when an event arrives after they are stale (a new treasurer gets team events)', async () => {
    running = await start(20_000, 400);
    // Opens the stream before creating the organization: no role yet.
    const client = await connect(running, 'newcomer::1');
    await client.waitFor(': connected');
    running.bus.publish({ type: 'cycle', cycleId: 'c0', status: 'running' }, TREASURY_TEAM);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(client.text()).not.toContain('event: cycle');

    // The organization is created: the party is the treasurer now. The roles are not stale yet,
    // so the next event is still judged on the old ones...
    ROLES['newcomer::1'] = ['treasurer'];
    running.bus.publish({ type: 'cycle', cycleId: 'c1', status: 'running' }, TREASURY_TEAM);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.text()).not.toContain('event: cycle');

    // ...and once they are older than the refresh interval, the next event looks them up again.
    await new Promise((resolve) => setTimeout(resolve, 450));
    running.bus.publish({ type: 'cycle', cycleId: 'c2', status: 'running' }, TREASURY_TEAM);
    await client.waitFor('event: cycle\n');
    expect(client.text()).toContain('"cycleId":"c2"');
    expect(client.text()).not.toContain('"cycleId":"c1"');
    delete ROLES['newcomer::1'];
    client.controller.abort();
  });

  it('keeps events in order and survives a failed role lookup', async () => {
    running = await start(20_000, 0);
    const client = await connect(running, 'treasurer::1');
    await client.waitFor(': connected');
    running.app.roleResolver.resolveRoles = () => Promise.reject(new Error('ledger busy'));
    running.bus.publish({ type: 'cycle', cycleId: 'a', status: 'running' }, TREASURY_TEAM);
    running.bus.publish({ type: 'cycle', cycleId: 'b', status: 'running' }, TREASURY_TEAM);
    await client.waitFor('"cycleId":"b"');
    const ids = [...client.text().matchAll(/"cycleId":"(\w)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['a', 'b']);
    client.controller.abort();
  });

  it('sends a heartbeat comment', async () => {
    running = await start(40);
    const client = await connect(running, 'treasurer::1');
    await client.waitFor(': heartbeat');
    client.controller.abort();
  });

  it('cleans up when the client disconnects', async () => {
    running = await start();
    const client = await connect(running, 'treasurer::1');
    await client.waitFor(': connected');
    expect(running.active()).toBe(1);
    client.controller.abort();
    const deadline = Date.now() + 1500;
    while (running.active() > 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    expect(running.active()).toBe(0);
  });

  it('does not keep the server from closing while clients are connected', async () => {
    running = await start();
    const client = await connect(running, 'treasurer::1');
    await client.waitFor(': connected');
    const closing = running.app.close();
    await expect(
      Promise.race([
        closing.then(() => 'closed'),
        new Promise((r) => setTimeout(() => r('hung'), 2000)),
      ]),
    ).resolves.toBe('closed');
    running = undefined;
  });
});
