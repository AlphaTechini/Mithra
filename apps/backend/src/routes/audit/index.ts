import {
  CreateAuditRequestSchema,
  DenyAccessRequestSchema,
  GrantAccessRequestSchema,
  type AuditRequestDetail,
  type AuditRequestsResponse,
  type EvidenceRoom,
} from '@mithra/shared';
import type { FastifyError, FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';
import type { AuditService, Viewer } from '../../audit/service';
import { requireRole, requireRoleOrNone, rolesOfRequest } from '../../auth/roles';
import { ApiError, errorBody, parse, upstreamErrorResponse } from '../../http/errors';

export interface AuditRouteDeps {
  service: AuditService;
}

const RequestParams = z.object({ requestId: z.string().min(1).max(100) });
// A grant id is `grant/<requestId>`: a client sends it URL-encoded (`grant%2Faudit-...`) or
// without the prefix; both reach the service the same way.
const GrantParams = z.object({ grantId: z.string().min(1).max(200) });

/** The signed-in party; the role hooks have already checked there is one. */
function partyOf(request: FastifyRequest): string {
  const partyId = request.session?.partyId;
  if (!partyId) throw new ApiError(401, 'not_signed_in', 'Sign in and pick a party first.');
  return partyId;
}

/** Same mapping as the application's global handler, so the routes behave the same in any app. */
function handleError(
  error: FastifyError | ZodError | ApiError,
  request: FastifyRequest,
  reply: { code(status: number): { send(body: unknown): unknown } },
): unknown {
  if (error instanceof ApiError) {
    return reply.code(error.status).send(errorBody(error.code, error.message));
  }
  const upstream = upstreamErrorResponse(error);
  if (upstream) {
    request.log.warn({ err: error }, 'upstream request failed');
    return reply.code(upstream.status).send(upstream.body);
  }
  if (error instanceof ZodError) {
    const message = error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return reply.code(400).send(errorBody('validation_error', message));
  }
  const status =
    'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
  if (status >= 500) {
    request.log.error({ err: error }, 'request failed');
    return reply.code(status).send(errorBody('internal_error', 'Internal server error'));
  }
  return reply.code(status).send(errorBody('bad_request', error.message));
}

/**
 * Registers the audit routes (the contract in shared/api/audit.ts). Roles: an auditor sees only
 * their own requests and grants (404 otherwise), the treasurer sees all, approvers and holders get 403.
 * A signed-in party with no role yet may draft a scope, create a request and list their own (none
 * yet), as a prospective auditor.
 */
export function auditRoutes(app: FastifyInstance, deps: AuditRouteDeps): void {
  const { service } = deps;
  const auditorOnly = requireRole('auditor');
  const treasurerOnly = requireRole('treasurer');
  const auditorOrTreasurer = requireRole('auditor', 'treasurer');
  // A party with no role yet may ask this fund for access: they become an auditor with the request.
  const auditorOrProspect = requireRoleOrNone('auditor');
  const auditorTreasurerOrProspect = requireRoleOrNone('auditor', 'treasurer');

  async function viewerOf(request: FastifyRequest): Promise<Viewer> {
    const { roles } = await rolesOfRequest(request);
    return { partyId: partyOf(request), isTreasurer: roles.includes('treasurer') };
  }

  app.post(
    '/api/audit/requests',
    { preHandler: auditorOrProspect },
    async (request): Promise<AuditRequestDetail> => {
      const body = parse(CreateAuditRequestSchema, request.body);
      return service.createRequest(partyOf(request), body);
    },
  );

  app.get(
    '/api/audit/requests',
    { preHandler: auditorTreasurerOrProspect },
    async (request, reply): Promise<AuditRequestsResponse> => {
      void reply.header('cache-control', 'no-store');
      return service.list(await viewerOf(request));
    },
  );

  app.get(
    '/api/audit/requests/:requestId',
    { preHandler: auditorOrTreasurer },
    async (request, reply): Promise<AuditRequestDetail> => {
      void reply.header('cache-control', 'no-store');
      const { requestId } = parse(RequestParams, request.params);
      return service.detail(requestId, await viewerOf(request));
    },
  );

  app.post(
    '/api/audit/requests/:requestId/grant',
    { preHandler: treasurerOnly },
    async (request): Promise<AuditRequestDetail> => {
      const { requestId } = parse(RequestParams, request.params);
      const body = parse(GrantAccessRequestSchema, request.body);
      return service.grant(requestId, partyOf(request), body);
    },
  );

  app.post(
    '/api/audit/requests/:requestId/deny',
    { preHandler: treasurerOnly },
    async (request): Promise<AuditRequestDetail> => {
      const { requestId } = parse(RequestParams, request.params);
      const body = parse(DenyAccessRequestSchema, request.body);
      return service.deny(requestId, partyOf(request), body);
    },
  );

  app.post(
    '/api/audit/requests/:requestId/withdraw',
    { preHandler: auditorOnly },
    async (request): Promise<AuditRequestDetail> => {
      const { requestId } = parse(RequestParams, request.params);
      return service.withdraw(requestId, partyOf(request));
    },
  );

  app.post(
    '/api/audit/grants/:grantId/revoke',
    { preHandler: treasurerOnly },
    async (request): Promise<AuditRequestDetail> => {
      const { grantId } = parse(GrantParams, request.params);
      return service.revoke(grantId, partyOf(request));
    },
  );

  app.get(
    '/api/audit/grants/:grantId/evidence',
    { preHandler: auditorOnly },
    async (request, reply): Promise<EvidenceRoom> => {
      // The records are not for shared caches or the back button after the grant ends.
      void reply.header('cache-control', 'no-store');
      const { grantId } = parse(GrantParams, request.params);
      return service.evidence(grantId, partyOf(request));
    },
  );

  app.get(
    '/api/audit/grants/:grantId/export',
    { preHandler: auditorOnly },
    async (request, reply): Promise<string> => {
      const { grantId } = parse(GrantParams, request.params);
      const { filename, markdown } = await service.exportMarkdown(grantId, partyOf(request));
      void reply
        .header('content-type', 'text/markdown; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .header('cache-control', 'no-store');
      return markdown;
    },
  );
}

/**
 * The same routes as a Fastify plugin with its own error handler, for `app.register(plugin)` after
 * the session plugin.
 */
export function createAuditRoutesPlugin(deps: AuditRouteDeps): FastifyPluginAsync {
  return (app) => {
    app.setErrorHandler(handleError);
    auditRoutes(app, deps);
    return Promise.resolve();
  };
}
