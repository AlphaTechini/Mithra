/**
 * Typed calls for the invitation and holder screens (userflow 6). Every response is parsed with
 * the shared schema. Holder endpoints only ever carry the signed-in holder's own data (U7); the
 * browser never combines or computes amounts.
 */
import {
  HolderPositionSchema,
  InviteSchema,
  TxDetailSchema,
  type HolderPosition,
  type Invite,
  type TxDetail,
} from '@mithra/shared';
import { apiGet, apiPost } from '$lib/api/client';

/** GET /api/invites/:code (public). Throws ApiError with status 404 for an unknown code. */
export function fetchInvite(code: string): Promise<Invite> {
  return apiGet(`/invites/${encodeURIComponent(code)}`, InviteSchema);
}

/** GET /api/me/position (holder). */
export function fetchPosition(): Promise<HolderPosition> {
  return apiGet('/me/position', HolderPositionSchema);
}

/** POST /api/me/units/:unitId/accept: accept one tranche of units. */
export function acceptUnits(unitId: string): Promise<HolderPosition> {
  return apiPost(`/me/units/${encodeURIComponent(unitId)}/accept`, HolderPositionSchema);
}

/**
 * POST /api/me/auto-receive. LocalNet creates the preapproval; MainNet verifies that the holder
 * turned it on in Grofty (the same call backs "Check again").
 */
export function enableAutoReceive(): Promise<HolderPosition> {
  return apiPost('/me/auto-receive', HolderPositionSchema);
}

/** POST /api/me/payments/:paymentId/accept: accept a pending transfer. */
export function acceptPayment(paymentId: string): Promise<HolderPosition> {
  return apiPost(`/me/payments/${encodeURIComponent(paymentId)}/accept`, HolderPositionSchema);
}

/** GET /api/tx/:updateId: the server returns only what the viewer may see. */
export function fetchTx(updateId: string): Promise<TxDetail> {
  return apiGet(`/tx/${encodeURIComponent(updateId)}`, TxDetailSchema);
}
