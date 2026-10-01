import type { Role } from '@mithra/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { Database } from '../db';
import { invites } from '../db/schema';
import { ApiError } from '../http/errors';
import type { MithraReader, RoleFacts } from '../ledger';

export interface RoleResolution {
  roles: Role[];
  /** The role the UI routes to first: treasurer, approver, auditor, holder. Null when there is none. */
  primaryRole: Role | null;
}

const PRIMARY_ORDER: readonly Role[] = ['treasurer', 'approver', 'auditor', 'holder'];

/**
 * The roles of `partyId`, from what the ledger shows and the unused auditor invites:
 * - treasurer: `Organization.treasurer`;
 * - approver: in `Organization.approvers`;
 * - holder: in the unit register with a positive net balance;
 * - auditor: auditor of any audit request, grant, closed grant or denial, or an invited auditor.
 */
export function computeRoles(
  partyId: string,
  facts: RoleFacts,
  invitedAuditors: ReadonlySet<string>,
): RoleResolution {
  const roles = new Set<Role>();
  const org = facts.organization?.payload;
  if (org?.treasurer === partyId) roles.add('treasurer');
  if (org?.approvers.includes(partyId)) roles.add('approver');

  if (facts.register) {
    const balance = facts.register.payload.changes
      .filter((c) => c.holder === partyId)
      .reduce((sum, c) => sum + c.delta, 0);
    if (balance > 0) roles.add('holder');
  }

  const isAuditor =
    facts.auditRequests.some((r) => r.payload.auditor === partyId) ||
    facts.grants.some((g) => g.payload.auditor === partyId) ||
    facts.closed.some((c) => c.payload.auditor === partyId) ||
    facts.denied.some((d) => d.payload.auditor === partyId) ||
    invitedAuditors.has(partyId);
  if (isAuditor) roles.add('auditor');

  const ordered = PRIMARY_ORDER.filter((r) => roles.has(r));
  return { roles: ordered, primaryRole: ordered[0] ?? null };
}

export interface RoleResolver {
  /** Roles of one party. */
  resolveRoles(partyId: string): Promise<RoleResolution>;
  /** Roles of several parties from one ledger read. */
  resolveMany(partyIds: readonly string[]): Promise<Map<string, RoleResolution>>;
}

export function createRoleResolver(deps: { reader: MithraReader; db: Database }): RoleResolver {
  async function load(): Promise<{ facts: RoleFacts; invited: Set<string> }> {
    const [facts, rows] = await Promise.all([
      deps.reader.roleFacts(),
      deps.db
        .select({ partyId: invites.partyId })
        .from(invites)
        .where(and(eq(invites.kind, 'auditor'), isNull(invites.usedAt))),
    ]);
    const invited = new Set<string>();
    for (const row of rows) if (row.partyId) invited.add(row.partyId);
    return { facts, invited };
  }
  const resolver: RoleResolver = {
    async resolveMany(partyIds) {
      const { facts, invited } = await load();
      return new Map(partyIds.map((p) => [p, computeRoles(p, facts, invited)]));
    },
    async resolveRoles(partyId) {
      const { facts, invited } = await load();
      return computeRoles(partyId, facts, invited);
    },
  };
  return resolver;
}

// Cache per request: a handler and its preHandlers share one ledger read.
const requestCache = new WeakMap<FastifyRequest, Promise<RoleResolution>>();

/** Roles of the signed-in party of `request`, resolved once per request. */
export function rolesOfRequest(request: FastifyRequest): Promise<RoleResolution> {
  const partyId = request.session?.partyId;
  if (!partyId) return Promise.resolve({ roles: [], primaryRole: null });
  let cached = requestCache.get(request);
  if (!cached) {
    cached = request.server.roleResolver.resolveRoles(partyId);
    requestCache.set(request, cached);
  }
  return cached;
}

/** A preHandler that lets only parties with at least one of `roles` through. */
export function requireRole(...roles: Role[]): preHandlerAsyncHookHandler {
  return async function requireRoleHook(request: FastifyRequest): Promise<void> {
    if (!request.session?.partyId) {
      throw new ApiError(401, 'not_signed_in', 'Sign in and pick a party first.');
    }
    const resolution = await rolesOfRequest(request);
    if (!roles.some((r) => resolution.roles.includes(r))) {
      throw new ApiError(
        403,
        'forbidden_role',
        `This needs the ${roles.join(' or ')} role. Switch to a party that has it.`,
      );
    }
  };
}

/**
 * Like `requireRole`, and also lets through a signed-in party that has no role at all: a prospective
 * auditor who has not asked this fund for anything yet (userflow 11.1). A treasurer, approver or
 * holder without one of `roles` is still refused.
 */
export function requireRoleOrNone(...roles: Role[]): preHandlerAsyncHookHandler {
  return async function requireRoleOrNoneHook(request: FastifyRequest): Promise<void> {
    if (!request.session?.partyId) {
      throw new ApiError(401, 'not_signed_in', 'Sign in and pick a party first.');
    }
    const resolution = await rolesOfRequest(request);
    if (resolution.roles.length === 0) return;
    if (!roles.some((r) => resolution.roles.includes(r))) {
      throw new ApiError(
        403,
        'forbidden_role',
        `This needs the ${roles.join(' or ')} role. Switch to a party that has it.`,
      );
    }
  };
}
