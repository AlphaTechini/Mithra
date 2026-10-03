import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionRoutes } from '../../test/treasury/fixtures';
import { errorResponse, stubApi } from '../../test/treasury/stub';
import { sessionStore } from './session.svelte';

const SIGNED_IN = {
  network: 'localnet',
  testMode: true,
  signedIn: true,
  party: {
    partyId: 'holderA::1220c1',
    displayName: 'Holder A',
    roles: ['holder'],
    primaryRole: 'holder',
  },
};

beforeEach(() => sessionStore.reset());
afterEach(() => vi.unstubAllGlobals());

describe('session store after sign-in and switching', () => {
  it('a successful signIn clears an earlier error and is ready, so the gate shows the app', async () => {
    let failing = false;
    const api = stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/session': () =>
        failing
          ? errorResponse(503, 'unavailable', 'Down.')
          : sessionRoutes('treasurer')['GET /api/session'],
      'POST /api/session/localnet/sign-in': SIGNED_IN,
    });
    await sessionStore.load();
    failing = true;
    await sessionStore.refresh();
    expect(sessionStore.status).toBe('error');
    expect(sessionStore.error).not.toBeNull();

    await sessionStore.signIn('demo');
    expect(api.callsTo('POST /api/session/localnet/sign-in')).toHaveLength(1);
    expect(sessionStore.status).toBe('ready');
    expect(sessionStore.error).toBeNull();
    expect(sessionStore.party?.displayName).toBe('Holder A');
  });

  it('a successful switchParty clears an earlier error and is ready', async () => {
    let failing = false;
    stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/session': () =>
        failing
          ? errorResponse(503, 'unavailable', 'Down.')
          : sessionRoutes('treasurer')['GET /api/session'],
      'POST /api/session/switch': SIGNED_IN,
    });
    await sessionStore.load();
    failing = true;
    await sessionStore.refresh();
    expect(sessionStore.status).toBe('error');

    await sessionStore.switchParty('holderA::1220c1');
    expect(sessionStore.status).toBe('ready');
    expect(sessionStore.error).toBeNull();
  });

  it('without a loaded config the status is left alone', async () => {
    stubApi({ 'POST /api/session/localnet/sign-in': SIGNED_IN });
    await sessionStore.signIn('demo');
    expect(sessionStore.session?.signedIn).toBe(true);
    expect(sessionStore.status).toBe('idle');
  });
});
