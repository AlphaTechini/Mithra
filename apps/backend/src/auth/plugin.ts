import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE, type SessionData, type SessionService } from './sessions';
import type { RoleResolver } from './roles';

declare module 'fastify' {
  interface FastifyRequest {
    /** The session of the request, or null when there is none (or it expired). */
    session: SessionData | null;
  }
  interface FastifyInstance {
    sessions: SessionService;
    roleResolver: RoleResolver;
  }
}

export interface SessionPluginOptions {
  sessions: SessionService;
  roleResolver: RoleResolver;
}

function isLocalHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

/** Sets the signed httpOnly session cookie. `secure` unless the request is for localhost. */
export function setSessionCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  sessionId: string,
  expiresAt: Date,
): void {
  void reply.setCookie(SESSION_COOKIE, sessionId, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: !isLocalHost(request.hostname.replace(/:\d+$/, '')),
    signed: true,
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  void reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/**
 * True for requests that can use a session: the API routes, except the health probe. Static assets
 * and `/api/health` never read the session, so they skip the cookie check and the database lookup.
 */
export function needsSession(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return path.startsWith('/api/') && path !== '/api/health';
}

/**
 * Loads the session of API requests into `request.session`. Register it after `@fastify/cookie`
 * (configured with the signing secret). It is marked as a non-encapsulated plugin, as
 * fastify-plugin would do, so its decorators and hook reach every route.
 */
export const sessionPlugin: FastifyPluginAsync<SessionPluginOptions> = (app, options) => {
  app.decorate('sessions', options.sessions);
  app.decorate('roleResolver', options.roleResolver);
  app.decorateRequest('session', null);
  app.addHook('onRequest', async (request) => {
    request.session = null;
    if (!needsSession(request.url)) return;
    const raw = request.cookies[SESSION_COOKIE];
    if (!raw) return;
    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid) return;
    request.session = await options.sessions.find(unsigned.value);
  });
  return Promise.resolve();
};
(sessionPlugin as unknown as Record<symbol, boolean>)[Symbol.for('skip-override')] = true;
