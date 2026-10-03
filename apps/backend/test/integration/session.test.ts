import {
  SessionResponseSchema,
  StatusResponseSchema,
  DemoPartiesResponseSchema,
} from '@mithra/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { createDatabase, runMigrations, type DatabaseHandle } from '../../src/db';
import { invites } from '../../src/db/schema';
import { createWorld, requireSandbox, DATABASE_URL_TEST, type World } from './helpers';

function cookieOf(res: LightMyRequestResponse): string {
  const header = res.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  return (value ?? '').split(';')[0] ?? '';
}

describe('session flow against a Canton sandbox and PostgreSQL', () => {
  let world: World;
  let database: DatabaseHandle;
  let app: FastifyInstance;

  beforeAll(async () => {
    await requireSandbox();
    world = await createWorld();
    database = createDatabase(DATABASE_URL_TEST);
    await runMigrations(database.db);
    app = buildApp(world.config, { database, ledger: world.ledger });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it('is signed out without a cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/session' });
    expect(res.statusCode).toBe(200);
    expect(SessionResponseSchema.parse(res.json())).toEqual({
      network: 'localnet',
      testMode: true,
      signedIn: false,
      party: null,
    });
    const parties = await app.inject({ method: 'GET', url: '/api/session/demo-parties' });
    expect(parties.statusCode).toBe(401);
  });

  it('rejects a wrong password with a 401 that says what to do', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/session/localnet/sign-in',
      payload: { password: 'nope' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: {
        code: 'invalid_password',
        message: 'That password is not right. Check LOCALNET_DEMO_PASSWORD in your .env.',
      },
    });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rejects a body without a password with invalid_request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/session/localnet/sign-in',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(res.json<{ error: { message: string } }>().error.message).toContain('password');
  });

  it('signs in, switches between demo parties and resolves roles from the ledger', async () => {
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/session/localnet/sign-in',
      payload: { password: 'demo-password' },
    });
    expect(signIn.statusCode).toBe(200);
    const cookie = cookieOf(signIn);
    expect(cookie).toMatch(/^mithra_session=/);
    const setCookie = String(signIn.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('Secure');
    expect(SessionResponseSchema.parse(signIn.json())).toMatchObject({
      signedIn: true,
      party: null,
    });

    const headers = { cookie };
    const afterSignIn = await app.inject({ method: 'GET', url: '/api/session', headers });
    expect(afterSignIn.json()).toMatchObject({ signedIn: true, party: null });

    // The role switcher lists the demo parties with the roles the ledger gives them.
    const demo = DemoPartiesResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/session/demo-parties', headers })).json(),
    );
    expect(demo.parties.map((p) => [p.displayName, p.roles])).toEqual([
      ['Treasurer', ['treasurer']],
      ['Approver 1', ['approver']],
      ['Holder A', ['holder']],
      ['Newcomer', []],
    ]);

    const asTreasurer = await app.inject({
      method: 'POST',
      url: '/api/session/switch',
      headers,
      payload: { partyId: world.parties.treasurer },
    });
    expect(asTreasurer.statusCode).toBe(200);
    expect(SessionResponseSchema.parse(asTreasurer.json()).party).toEqual({
      partyId: world.parties.treasurer,
      displayName: 'Treasurer',
      roles: ['treasurer'],
      primaryRole: 'treasurer',
    });

    const current = await app.inject({ method: 'GET', url: '/api/session', headers });
    expect(SessionResponseSchema.parse(current.json()).party?.primaryRole).toBe('treasurer');

    for (const [partyId, name, role] of [
      [world.parties.approver1, 'Approver 1', 'approver'],
      [world.parties.holderA, 'Holder A', 'holder'],
    ] as const) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/session/switch',
        headers,
        payload: { partyId },
      });
      expect(SessionResponseSchema.parse(res.json()).party).toEqual({
        partyId,
        displayName: name,
        roles: [role],
        primaryRole: role,
      });
    }

    // An unknown party has no roles: the UI offers "Set up a treasury" / "I was invited".
    const outsider = await app.inject({
      method: 'POST',
      url: '/api/session/switch',
      headers,
      payload: { partyId: world.parties.outsider },
    });
    expect(SessionResponseSchema.parse(outsider.json()).party).toMatchObject({
      displayName: 'Newcomer',
      roles: [],
      primaryRole: null,
    });

    // An unused auditor invite for that party makes it an auditor.
    await database.db.insert(invites).values({
      code: `inv-${world.parties.outsider.slice(0, 12)}`,
      kind: 'auditor',
      partyId: world.parties.outsider,
      displayName: 'Newcomer',
      createdBy: world.parties.treasurer,
    });
    const invited = await app.inject({ method: 'GET', url: '/api/session', headers });
    expect(SessionResponseSchema.parse(invited.json()).party).toMatchObject({
      roles: ['auditor'],
      primaryRole: 'auditor',
    });

    // A party that is not in the demo list is refused.
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/session/switch',
      headers,
      payload: { partyId: world.parties.holderB },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ error: { code: 'unknown_party' } });
    // The session still has the previous party.
    const still = await app.inject({ method: 'GET', url: '/api/session', headers });
    expect(SessionResponseSchema.parse(still.json()).party?.partyId).toBe(world.parties.outsider);

    // Sign out ends the session.
    const out = await app.inject({ method: 'POST', url: '/api/session/sign-out', headers });
    expect(out.statusCode).toBe(204);
    const after = await app.inject({ method: 'GET', url: '/api/session', headers });
    expect(after.json()).toMatchObject({ signedIn: false, party: null });
  });

  it('requires a session to switch and ignores a tampered cookie', async () => {
    const noSession = await app.inject({
      method: 'POST',
      url: '/api/session/switch',
      payload: { partyId: world.parties.treasurer },
    });
    expect(noSession.statusCode).toBe(401);
    const forged = await app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { cookie: 'mithra_session=00000000-0000-4000-8000-000000000000.forged' },
    });
    expect(forged.json()).toMatchObject({ signedIn: false });
  });

  it('limits sign-in attempts to 10 per minute per IP', async () => {
    const limited = buildApp(world.config, { database, ledger: world.ledger });
    await limited.ready();
    let last = 0;
    for (let i = 0; i < 11; i += 1) {
      const res = await limited.inject({
        method: 'POST',
        url: '/api/session/localnet/sign-in',
        payload: { password: 'wrong' },
      });
      last = res.statusCode;
      if (i < 10) expect(last).toBe(401);
    }
    expect(last).toBe(429);
    await limited.close();
  });

  it('reports the ledger version, the database and the nodes in /api/status', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(200);
    const status = StatusResponseSchema.parse(res.json());
    expect(status.ledger.ok).toBe(true);
    expect(status.ledger.version).toMatch(/^3\./);
    expect(status.database).toEqual({ ok: true });
    expect(status.nodes?.map((n) => [n.id, n.ok])).toEqual([
      ['a', true],
      ['b', false],
      ['c', false],
    ]);
  });
});
