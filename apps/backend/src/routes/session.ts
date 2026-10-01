import { timingSafeEqual, createHash } from 'node:crypto';
import {
  LocalnetSignInRequestSchema,
  SwitchPartyRequestSchema,
  type DemoPartiesResponse,
  type Role,
  type SessionResponse,
} from '@mithra/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { clearSessionCookie, setSessionCookie } from '../auth/plugin';
import { rolesOfRequest, type RoleResolution } from '../auth/roles';
import type { Config } from '../config/env';
import { ApiError, parse } from '../http/errors';
import { RateLimiter } from '../http/rateLimit';
import { LedgerError } from '../ledger';

const ROLE_LABELS: Record<Role, string> = {
  treasurer: 'Treasurer',
  approver: 'Approver',
  holder: 'Holder',
  auditor: 'Auditor',
};

/** A short form of a party id: the name and the first characters of its fingerprint. */
export function shortParty(partyId: string): string {
  const [name = partyId, fingerprint] = partyId.split('::');
  if (!fingerprint) return partyId.length > 14 ? `${partyId.slice(0, 12)}...` : partyId;
  return `${name.slice(0, 16)}::${fingerprint.slice(0, 6)}...`;
}

function displayNameFor(config: Config, partyId: string, resolution: RoleResolution): string {
  if (config.network === 'localnet') {
    const demo = config.localnet.demoParties.find((p) => p.partyId === partyId);
    if (demo) return demo.displayName;
  }
  const label = resolution.primaryRole ? ROLE_LABELS[resolution.primaryRole] : 'Party';
  return `${label} ${shortParty(partyId)}`;
}

/** Compares two strings in constant time (hashes first so the lengths do not leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export interface SessionRouteOptions {
  /** Sign-in attempts per IP per window. Default 10 per minute. */
  signInLimit?: { limit: number; windowMs: number; now?: () => number };
}

export function sessionRoutes(
  app: FastifyInstance,
  config: Config,
  options: SessionRouteOptions = {},
): void {
  const testMode = config.network === 'localnet';
  const limiter = new RateLimiter(options.signInLimit ?? { limit: 10, windowMs: 60_000 });

  async function sessionResponse(request: FastifyRequest): Promise<SessionResponse> {
    const session = request.session;
    if (!session) return { network: config.network, testMode, signedIn: false, party: null };
    if (!session.partyId) return { network: config.network, testMode, signedIn: true, party: null };
    const resolution = await rolesOfRequest(request);
    return {
      network: config.network,
      testMode,
      signedIn: true,
      party: {
        partyId: session.partyId,
        displayName: displayNameFor(config, session.partyId, resolution),
        roles: resolution.roles,
        primaryRole: resolution.primaryRole,
      },
    };
  }

  function requireLocalnet(): void {
    if (config.network !== 'localnet') {
      throw new ApiError(
        404,
        'not_available',
        'This is only available on LocalNet. On MainNet, connect Grofty Wallet.',
      );
    }
  }

  function requireSession(request: FastifyRequest): string {
    if (!request.session) {
      throw new ApiError(401, 'not_signed_in', 'Sign in first.');
    }
    return request.session.id;
  }

  app.get('/api/session', (request) => sessionResponse(request));

  app.get('/api/session/demo-parties', async (request, reply): Promise<DemoPartiesResponse> => {
    requireLocalnet();
    requireSession(request);
    const demo = config.localnet?.demoParties ?? [];
    let resolved = new Map<string, RoleResolution>();
    try {
      resolved = await app.roleResolver.resolveMany(demo.map((p) => p.partyId));
    } catch (error) {
      // The switcher must still work when the ledger is down; roles then show as unknown.
      if (!(error instanceof LedgerError)) throw error;
      request.log.warn({ err: error }, 'could not resolve demo party roles');
    }
    void reply.header('cache-control', 'no-store');
    return {
      parties: demo.map((p) => ({
        partyId: p.partyId,
        displayName: p.displayName,
        roles: resolved.get(p.partyId)?.roles ?? [],
      })),
    };
  });

  app.post('/api/session/localnet/sign-in', async (request, reply): Promise<SessionResponse> => {
    requireLocalnet();
    if (!limiter.allow(request.ip)) {
      throw new ApiError(
        429,
        'too_many_requests',
        'Too many sign-in attempts. Wait a minute, then try again.',
      );
    }
    const body = parse(LocalnetSignInRequestSchema, request.body);
    if (config.network !== 'localnet' || !safeEqual(body.password, config.localnet.demoPassword)) {
      throw new ApiError(
        401,
        'invalid_password',
        'That password is not right. Check LOCALNET_DEMO_PASSWORD in your .env.',
      );
    }
    // A new session on every sign-in, so a session id from before the password is never reused.
    if (request.session) await app.sessions.destroy(request.session.id);
    const created = await app.sessions.create(null);
    setSessionCookie(request, reply, created.id, created.expiresAt);
    return { network: config.network, testMode, signedIn: true, party: null };
  });

  app.post('/api/session/switch', async (request): Promise<SessionResponse> => {
    requireLocalnet();
    const sessionId = requireSession(request);
    const body = parse(SwitchPartyRequestSchema, request.body);
    const known = config.localnet?.demoParties.some((p) => p.partyId === body.partyId) ?? false;
    if (!known) {
      throw new ApiError(
        400,
        'unknown_party',
        'That party is not one of the demo parties. Pick one from the role switcher.',
      );
    }
    await app.sessions.setParty(sessionId, body.partyId);
    request.session = { id: sessionId, partyId: body.partyId };
    return sessionResponse(request);
  });

  app.post('/api/session/sign-out', async (request, reply) => {
    if (request.session) await app.sessions.destroy(request.session.id);
    clearSessionCookie(reply);
    return reply.code(204).send();
  });
}
