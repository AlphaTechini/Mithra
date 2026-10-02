import { SignJWT } from 'jose';
import type { LedgerAuthConfig } from '../config/env';

/** Supplies the bearer token for ledger requests; null means "send no Authorization header". */
export interface TokenProvider {
  getToken(): Promise<string | null>;
}

export interface Clock {
  now(): number;
}

const systemClock: Clock = { now: () => Date.now() };

/** Refresh a cached token this long before it expires. */
const EXPIRY_MARGIN_MS = 30_000;

/**
 * LocalNet: an HS256 JWT signed with a shared secret, `{ aud, sub }`. Tokens last an hour and
 * are cached until shortly before they expire.
 */
export function unsafeHmac(options: {
  secret: string;
  audience: string;
  userId: string;
  clock?: Clock;
  lifetimeSeconds?: number;
}): TokenProvider {
  const clock = options.clock ?? systemClock;
  const lifetime = options.lifetimeSeconds ?? 3600;
  const key = new TextEncoder().encode(options.secret);
  let cached: { token: string; expiresAtMs: number } | undefined;
  return {
    async getToken() {
      if (cached && clock.now() < cached.expiresAtMs - EXPIRY_MARGIN_MS) return cached.token;
      const issuedAt = Math.floor(clock.now() / 1000);
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setAudience(options.audience)
        .setSubject(options.userId)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + lifetime)
        .sign(key);
      cached = { token, expiresAtMs: (issuedAt + lifetime) * 1000 };
      return token;
    },
  };
}

const OIDC_TIMEOUT_MS = 10_000;

/**
 * MainNet: OIDC client credentials. The token is cached until shortly before `expires_in`;
 * concurrent callers share one request.
 */
export function oidcClientCredentials(options: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  audience: string;
  scope: string;
  fetch?: typeof fetch;
  clock?: Clock;
}): TokenProvider {
  const clock = options.clock ?? systemClock;
  const doFetch = options.fetch ?? fetch;
  let cached: { token: string; expiresAtMs: number } | undefined;
  let inflight: Promise<string> | undefined;

  async function fetchToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: options.clientId,
      client_secret: options.clientSecret,
      audience: options.audience,
      scope: options.scope,
    });
    const response = await doFetch(options.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(OIDC_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `The ledger identity provider refused the token request (HTTP ${response.status}). Check LEDGER_OIDC_* in your .env.`,
      );
    }
    const json = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof json.access_token !== 'string' || json.access_token === '') {
      throw new Error('The ledger identity provider answered without an access_token.');
    }
    const expiresInSeconds =
      typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 300;
    cached = { token: json.access_token, expiresAtMs: clock.now() + expiresInSeconds * 1000 };
    return json.access_token;
  }

  return {
    async getToken() {
      if (cached && clock.now() < cached.expiresAtMs - EXPIRY_MARGIN_MS) return cached.token;
      inflight ??= fetchToken().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
  };
}

/** For a ledger without authentication (the local sandbox). */
export function none(): TokenProvider {
  return { getToken: () => Promise.resolve(null) };
}

/** The provider for the configured auth mode. */
export function createTokenProvider(auth: LedgerAuthConfig, userId: string): TokenProvider {
  switch (auth.mode) {
    case 'unsafe-hmac':
      return unsafeHmac({ secret: auth.secret, audience: auth.audience, userId });
    case 'oidc-client-credentials':
      return oidcClientCredentials(auth);
    case 'none':
      return none();
  }
}
