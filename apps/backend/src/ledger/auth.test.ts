import { decodeJwt, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { urlOf } from '../testUtils';
import { createTokenProvider, none, oidcClientCredentials, unsafeHmac } from './auth';

describe('unsafeHmac', () => {
  it('signs an HS256 token with the audience and the ledger user', async () => {
    const provider = unsafeHmac({
      secret: 'unsafe',
      audience: 'https://canton.network.global',
      userId: 'ledger-api-user',
    });
    const token = await provider.getToken();
    expect(token).toBeTruthy();
    const { payload, protectedHeader } = await jwtVerify(
      token ?? '',
      new TextEncoder().encode('unsafe'),
      {
        audience: 'https://canton.network.global',
      },
    );
    expect(protectedHeader.alg).toBe('HS256');
    expect(payload.sub).toBe('ledger-api-user');
  });

  it('caches the token until shortly before it expires', async () => {
    let now = Date.parse('2026-10-01T00:00:00Z');
    const provider = unsafeHmac({
      secret: 'unsafe',
      audience: 'a',
      userId: 'u',
      lifetimeSeconds: 600,
      clock: { now: () => now },
    });
    const first = await provider.getToken();
    now += 5 * 60 * 1000;
    expect(await provider.getToken()).toBe(first);
    now += 4.6 * 60 * 1000; // within the 30 s margin of the expiry
    const second = await provider.getToken();
    expect(second).not.toBe(first);
    expect(decodeJwt(second ?? '').exp).toBeGreaterThan(Math.floor(now / 1000));
  });
});

describe('oidcClientCredentials', () => {
  function stub(responses: { access_token: string; expires_in: number }[]) {
    const calls: { url: string; body: string; contentType: string | null }[] = [];
    const fetchStub: typeof fetch = (input, init) => {
      calls.push({
        url: urlOf(input),
        body: String(init?.body as string),
        contentType: new Headers(init?.headers).get('content-type'),
      });
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      return Promise.resolve(new Response(JSON.stringify(next), { status: 200 }));
    };
    return { calls, fetchStub };
  }

  const options = {
    tokenUrl: 'https://idp.example/token',
    clientId: 'cid',
    clientSecret: 'sec',
    audience: 'https://ledger.example',
    scope: 'daml_ledger_api',
  };

  it('refuses a token URL that is not https, except on loopback', () => {
    expect(() =>
      oidcClientCredentials({ ...options, tokenUrl: 'http://idp.example/token' }),
    ).toThrow(/LEDGER_OIDC_TOKEN_URL.*https:\/\//s);
    expect(() => oidcClientCredentials({ ...options, tokenUrl: 'not a url' })).toThrow(
      /LEDGER_OIDC_TOKEN_URL/,
    );
    for (const tokenUrl of [
      'https://idp.example/token',
      'http://localhost:8080/token',
      'http://keycloak.localhost/token',
      'http://127.0.0.1:8080/token',
      'http://[::1]:8080/token',
    ]) {
      expect(() => oidcClientCredentials({ ...options, tokenUrl })).not.toThrow();
    }
  });

  it('does not follow a redirect of the token endpoint, and fails with what to change', async () => {
    const seen: RequestInit[] = [];
    const provider = oidcClientCredentials({
      ...options,
      fetch: (_input, init) => {
        seen.push(init ?? {});
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }),
        );
      },
    });
    await expect(provider.getToken()).rejects.toThrow(
      /redirect \(HTTP 302 to https:\/\/evil.example\).*LEDGER_OIDC_TOKEN_URL/,
    );
    expect(seen[0]?.redirect).toBe('manual');
  });

  it('posts a client credentials form and caches the token until near expiry', async () => {
    const { calls, fetchStub } = stub([
      { access_token: 't1', expires_in: 300 },
      { access_token: 't2', expires_in: 300 },
    ]);
    let now = 0;
    const provider = oidcClientCredentials({
      ...options,
      fetch: fetchStub,
      clock: { now: () => now },
    });
    expect(await provider.getToken()).toBe('t1');
    expect(calls).toHaveLength(1);
    const form = new URLSearchParams(calls[0]?.body);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'client_credentials',
      client_id: 'cid',
      client_secret: 'sec',
      audience: 'https://ledger.example',
      scope: 'daml_ledger_api',
    });
    expect(calls[0]?.contentType).toBe('application/x-www-form-urlencoded');
    now = 200_000;
    expect(await provider.getToken()).toBe('t1');
    expect(calls).toHaveLength(1);
    now = 280_000; // inside the refresh margin
    expect(await provider.getToken()).toBe('t2');
    expect(calls).toHaveLength(2);
  });

  it('shares one request between concurrent callers', async () => {
    const { calls, fetchStub } = stub([{ access_token: 't1', expires_in: 300 }]);
    const provider = oidcClientCredentials({ ...options, fetch: fetchStub });
    const tokens = await Promise.all([
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
    ]);
    expect(tokens).toEqual(['t1', 't1', 't1']);
    expect(calls).toHaveLength(1);
  });

  it('explains a refused token request', async () => {
    const provider = oidcClientCredentials({
      ...options,
      fetch: () => Promise.resolve(new Response('no', { status: 401 })),
    });
    await expect(provider.getToken()).rejects.toThrow(/LEDGER_OIDC_\*/);
  });
});

describe('none and createTokenProvider', () => {
  it('sends no token', async () => {
    expect(await none().getToken()).toBeNull();
    expect(await createTokenProvider({ mode: 'none' }, 'u').getToken()).toBeNull();
  });

  it('picks the provider for the configured mode', async () => {
    const provider = createTokenProvider(
      { mode: 'unsafe-hmac', secret: 'unsafe', audience: 'aud' },
      'user-1',
    );
    expect(decodeJwt((await provider.getToken()) ?? '')).toMatchObject({
      aud: 'aud',
      sub: 'user-1',
    });
  });
});
