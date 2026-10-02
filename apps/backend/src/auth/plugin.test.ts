import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { needsSession, sessionPlugin } from './plugin';
import type { RoleResolver } from './roles';
import { SESSION_COOKIE, type SessionData, type SessionService } from './sessions';

const SECRET = 'plugin-test-secret';
const SESSION_ID = '11111111-2222-4333-8444-555555555555';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(finds: string[]): Promise<FastifyInstance> {
  const sessions = {
    find: (id: string): Promise<SessionData | null> => {
      finds.push(id);
      return Promise.resolve({ id, partyId: 'p::1' });
    },
  } as unknown as SessionService;
  const instance = Fastify();
  await instance.register(fastifyCookie, { secret: SECRET });
  await instance.register(sessionPlugin, { sessions, roleResolver: {} as RoleResolver });
  instance.get('/api/whoami', (request) => ({ session: request.session }));
  instance.get('/api/health', (request) => ({ session: request.session }));
  instance.get('/assets/app.js', (request) => ({ session: request.session }));
  instance.get('/', (request) => ({ session: request.session }));
  await instance.ready();
  return instance;
}

function signedCookie(instance: FastifyInstance): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(instance.signCookie(SESSION_ID))}`;
}

describe('needsSession', () => {
  it('is true for API paths except the health probe', () => {
    expect(needsSession('/api/session')).toBe(true);
    expect(needsSession('/api/treasury/policy?x=1')).toBe(true);
    expect(needsSession('/api/health')).toBe(false);
    expect(needsSession('/api/health?probe=1')).toBe(false);
    expect(needsSession('/assets/app.js')).toBe(false);
    expect(needsSession('/')).toBe(false);
    expect(needsSession('/apix')).toBe(false);
  });
});

describe('session plugin', () => {
  it('does not look up the session for static assets or /api/health', async () => {
    const finds: string[] = [];
    app = await build(finds);
    const headers = { cookie: signedCookie(app) };
    for (const url of ['/assets/app.js', '/', '/api/health']) {
      const res = await app.inject({ method: 'GET', url, headers });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ session: null });
    }
    expect(finds).toEqual([]);
  });

  it('still loads the session of an API route', async () => {
    const finds: string[] = [];
    app = await build(finds);
    const res = await app.inject({
      method: 'GET',
      url: '/api/whoami',
      headers: { cookie: signedCookie(app) },
    });
    expect(res.json()).toEqual({ session: { id: SESSION_ID, partyId: 'p::1' } });
    expect(finds).toEqual([SESSION_ID]);
  });

  it('ignores an unsigned cookie on an API route', async () => {
    const finds: string[] = [];
    app = await build(finds);
    const res = await app.inject({
      method: 'GET',
      url: '/api/whoami',
      headers: { cookie: `${SESSION_COOKIE}=${SESSION_ID}` },
    });
    expect(res.json()).toEqual({ session: null });
    expect(finds).toEqual([]);
  });
});
