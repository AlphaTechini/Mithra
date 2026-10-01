/**
 * Typed calls for the audit flow (userflow 11). Every response is parsed with the shared Zod
 * schema. Paths are relative to `/api`. The auditor sees record contents only through an active
 * grant; an ended grant answers `410 access_ended`.
 */
import {
  AuditRequestDetailSchema,
  AuditRequestsResponseSchema,
  EvidenceRoomSchema,
  ScopeDraftSchema,
  type AuditRequestDetail,
  type AuditRequestsResponse,
  type CreateAuditRequest,
  type DenyAccessRequest,
  type EvidenceRoom,
  type GrantAccessRequest,
  type ScopeDraft,
} from '@mithra/shared';
import { ApiError, apiGet, apiPost } from '$lib/api/client';

/** POST /api/audit/scope/draft: the agent's proposed scope for a plain-English question (A8). */
export function draftScope(question: string): Promise<ScopeDraft> {
  return apiPost('/audit/scope/draft', ScopeDraftSchema, { question });
}

/** POST /api/audit/requests (auditor). */
export function createAuditRequest(body: CreateAuditRequest): Promise<AuditRequestDetail> {
  return apiPost('/audit/requests', AuditRequestDetailSchema, body);
}

/** GET /api/audit/requests: the auditor's own requests, or every request for the treasurer. */
export function listAuditRequests(): Promise<AuditRequestsResponse> {
  return apiGet('/audit/requests', AuditRequestsResponseSchema);
}

/** GET /api/audit/requests/:requestId (the treasurer's copy carries the `preview`). */
export function getAuditRequest(requestId: string): Promise<AuditRequestDetail> {
  return apiGet(`/audit/requests/${encodeURIComponent(requestId)}`, AuditRequestDetailSchema);
}

/** POST /api/audit/requests/:requestId/grant (treasurer). */
export function grantAccess(
  requestId: string,
  body: GrantAccessRequest,
): Promise<AuditRequestDetail> {
  return apiPost(
    `/audit/requests/${encodeURIComponent(requestId)}/grant`,
    AuditRequestDetailSchema,
    body,
  );
}

/** POST /api/audit/requests/:requestId/deny (treasurer). */
export function denyAccess(
  requestId: string,
  body: DenyAccessRequest,
): Promise<AuditRequestDetail> {
  return apiPost(
    `/audit/requests/${encodeURIComponent(requestId)}/deny`,
    AuditRequestDetailSchema,
    body,
  );
}

/** POST /api/audit/grants/:grantId/revoke (treasurer): "End access now". */
export function revokeGrant(grantId: string): Promise<AuditRequestDetail> {
  return apiPost(`/audit/grants/${encodeURIComponent(grantId)}/revoke`, AuditRequestDetailSchema);
}

/** POST /api/audit/requests/:requestId/withdraw (auditor). */
export function withdrawRequest(requestId: string): Promise<AuditRequestDetail> {
  return apiPost(
    `/audit/requests/${encodeURIComponent(requestId)}/withdraw`,
    AuditRequestDetailSchema,
  );
}

/** GET /api/audit/grants/:grantId/evidence (auditor). Throws ApiError 410 once access has ended. */
export function getEvidence(grantId: string): Promise<EvidenceRoom> {
  return apiGet(`/audit/grants/${encodeURIComponent(grantId)}/evidence`, EvidenceRoomSchema);
}

/** The markdown summary download for working papers. Used as a plain link with `download`. */
export function exportUrl(grantId: string): string {
  return `/api/audit/grants/${encodeURIComponent(grantId)}/export`;
}

/** True when the server says the grant has ended (`410 access_ended`). */
export function isAccessEnded(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 410 || error.code === 'access_ended');
}
