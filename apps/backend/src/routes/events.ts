import type { FastifyInstance } from 'fastify';
import type { Role } from '@mithra/shared';
import { rolesOfRequest } from '../auth/roles';
import { inAudience, type EventBus } from '../events/bus';
import { ApiError } from '../http/errors';

export interface EventsRouteOptions {
  bus: EventBus;
  /** Comment line sent this often so proxies keep the stream open. Default 20 s. */
  heartbeatMs?: number;
  /** A connection looks up its viewer's roles again when an event arrives and they are older than this. Default 15 s. */
  roleRefreshMs?: number;
}

/**
 * `GET /api/events`: Server-Sent Events for the live timeline and status updates. A viewer only
 * receives events whose audience includes their party or one of their roles; the events carry ids
 * and statuses, and the client refetches what changed. Roles change while a stream is open (a
 * treasurer creates the organization, a holder is issued units), so they are resolved again, at
 * most every `roleRefreshMs`, when an event arrives.
 */
export function eventsRoute(app: FastifyInstance, options: EventsRouteOptions): void {
  const heartbeatMs = options.heartbeatMs ?? 20_000;
  const roleRefreshMs = options.roleRefreshMs ?? 15_000;
  const open = new Set<() => void>();

  app.get('/api/events', async (request, reply) => {
    const partyId = request.session?.partyId;
    if (!partyId) {
      throw new ApiError(401, 'not_signed_in', 'Sign in and pick a party to see live updates.');
    }
    let { roles } = await rolesOfRequest(request);
    let rolesAt = Date.now();
    const roleResolver = request.server.roleResolver;
    const viewer: string = partyId;

    // From here the response is ours: headers set by other hooks (CORS) are kept.
    const headers: Record<string, string | number | string[]> = {};
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) headers[name] = value;
    }
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      ...headers,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    raw.write('retry: 3000\n: connected\n\n');

    let closed = false;
    // Events are handled one after the other, so a role lookup never reorders what the viewer sees.
    let queue: Promise<void> = Promise.resolve();
    async function currentRoles(): Promise<readonly Role[]> {
      if (Date.now() - rolesAt >= roleRefreshMs) {
        try {
          roles = (await roleResolver.resolveRoles(viewer)).roles;
          rolesAt = Date.now();
        } catch {
          // The ledger is busy: keep the roles we have and try again with the next event.
        }
      }
      return roles;
    }
    const unsubscribe = options.bus.subscribe(({ event, audience }) => {
      queue = queue
        .then(async () => {
          if (closed) return;
          const current = audience.parties?.includes(partyId) ? roles : await currentRoles();
          if (closed || !inAudience(audience, partyId, current)) return;
          raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        })
        .catch(() => undefined);
    });
    const heartbeat = setInterval(() => {
      if (!closed) raw.write(': heartbeat\n\n');
    }, heartbeatMs);

    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      open.delete(close);
      if (!raw.writableEnded) raw.end();
      // A client that went away leaves nothing to finish: free the socket now.
      if (request.raw.destroyed || request.raw.socket?.destroyed) raw.destroy();
    };
    open.add(close);
    request.raw.on('close', close);
    raw.on('error', close);
  });

  // Open streams would keep the server from closing; end them first.
  app.addHook('preClose', () => {
    for (const close of [...open]) close();
  });
}
