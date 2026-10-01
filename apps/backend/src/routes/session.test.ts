import { SessionResponseSchema } from '@mithra/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import type { DatabaseHandle } from '../db';
import { createLedger } from '../ledger';
import { localnetTestConfig, mainnetTestConfig } from '../testConfig';
import { safeEqual, shortParty } from './session';

// These routes never touch the database or the ledger in the cases below (no cookie, wrong
// password, MainNet), so the dependencies are inert. The full flow runs in test/integration.
function deps(config = localnetTestConfig()) {
  return {
    database: {} as DatabaseHandle,
    ledger: createLedger(config, {
      fetch: () => Promise.reject(new Error('no ledger in unit tests')),
    }),
  };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('session routes without a session', () => {
  it('reports signed out', async () => {
    app = buildApp(localnetTestConfig(), deps());
    const res = await app.inject({ method: 'GET', url: '/api/session' });
    expect(SessionResponseSchema.parse(res.json())).toEqual({
      network: 'localnet',
      testMode: true,
      signedIn: false,
      party: null,
    });
  });

  it('reports MainNet without test mode', async () => {
    const config = mainnetTestConfig();
    app = buildApp(config, deps(config));
    const res = await app.inject({ method: 'GET', url: '/api/session' });
    expect(SessionResponseSchema.parse(res.json())).toMatchObject({
      network: 'mainnet',
      testMode: false,
      signedIn: false,
    });
  });

  it('answers 404 not_available for the LocalNet-only routes on MainNet', async () => {
    const config = mainnetTestConfig();
    app = buildApp(config, deps(config));
    for (const [method, url, payload] of [
      ['GET', '/api/session/demo-parties', undefined],
      ['POST', '/api/session/localnet/sign-in', { password: 'x' }],
      ['POST', '/api/session/switch', { partyId: 'p' }],
    ] as const) {
      const res = await app.inject({ method, url, ...(payload ? { payload } : {}) });
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: 'not_available' } });
    }
  });

  it('answers 401 for a wrong password, without a cookie, and 400 for a malformed body', async () => {
    app = buildApp(localnetTestConfig(), deps());
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/session/localnet/sign-in',
      payload: { password: 'nope' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({
      error: {
        code: 'invalid_password',
        message: 'That password is not right. Check LOCALNET_DEMO_PASSWORD in your .env.',
      },
    });
    expect(wrong.headers['set-cookie']).toBeUndefined();
    const bad = await app.inject({
      method: 'POST',
      url: '/api/session/localnet/sign-in',
      payload: { password: 5 },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('refuses the demo parties and a switch without a session', async () => {
    app = buildApp(localnetTestConfig(), deps());
    expect((await app.inject({ method: 'GET', url: '/api/session/demo-parties' })).statusCode).toBe(
      401,
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/session/switch',
      payload: { partyId: 'treasurer::1220aa' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'not_signed_in' } });
  });

  it('rate-limits sign-in attempts per IP', async () => {
    app = buildApp(localnetTestConfig(), {
      ...deps(),
      session: { signInLimit: { limit: 2, windowMs: 60_000 } },
    });
    const attempt = () =>
      app!.inject({
        method: 'POST',
        url: '/api/session/localnet/sign-in',
        payload: { password: 'nope' },
      });
    expect((await attempt()).statusCode).toBe(401);
    expect((await attempt()).statusCode).toBe(401);
    const limited = await attempt();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: 'too_many_requests' } });
  });
});

describe('helpers', () => {
  it('compares passwords in constant time', () => {
    expect(safeEqual('demo', 'demo')).toBe(true);
    expect(safeEqual('demo', 'demo ')).toBe(false);
    expect(safeEqual('', 'demo')).toBe(false);
  });

  it('shortens a party id to its name and the start of its fingerprint', () => {
    expect(shortParty('treasurer::1220abcdef0123456789')).toBe('treasurer::1220ab...');
    expect(shortParty('plainparty')).toBe('plainparty');
  });
});
