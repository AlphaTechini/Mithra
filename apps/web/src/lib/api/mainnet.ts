/**
 * Typed calls for MainNet payouts (M10): the treasurer's transfers to sign in Grofty, and the
 * holder's Grofty wallet. Every response is parsed with the shared schema.
 */
import {
  HolderPositionSchema,
  MainnetPayoutsResponseSchema,
  MainnetWalletChallengeResponseSchema,
  type HolderPosition,
  type MainnetPayoutsResponse,
  type MainnetTransferOutcome,
  type MainnetWalletChallengeResponse,
  type RegisterMainnetWalletRequest,
} from '@mithra/shared';
import { apiGet, apiPost } from '$lib/api/client';

/** GET /api/cycles/:cycleId/mainnet-payouts (treasurer). */
export function fetchMainnetPayouts(cycleId: string): Promise<MainnetPayoutsResponse> {
  return apiGet(
    `/cycles/${encodeURIComponent(cycleId)}/mainnet-payouts`,
    MainnetPayoutsResponseSchema,
  );
}

/** POST /api/cycles/:cycleId/mainnet-payouts/:paymentId: what Grofty reported for one transfer. */
export function recordMainnetPayout(
  cycleId: string,
  paymentId: string,
  body: { updateId: string; outcome: MainnetTransferOutcome },
): Promise<MainnetPayoutsResponse> {
  return apiPost(
    `/cycles/${encodeURIComponent(cycleId)}/mainnet-payouts/${encodeURIComponent(paymentId)}`,
    MainnetPayoutsResponseSchema,
    body,
  );
}

/** POST /api/me/mainnet-wallet/challenge (holder). */
export function requestWalletChallenge(): Promise<MainnetWalletChallengeResponse> {
  return apiPost('/me/mainnet-wallet/challenge', MainnetWalletChallengeResponseSchema);
}

/** POST /api/me/mainnet-wallet (holder): registers the wallet that signed the challenge. */
export function registerWallet(body: RegisterMainnetWalletRequest): Promise<HolderPosition> {
  return apiPost('/me/mainnet-wallet', HolderPositionSchema, body);
}
