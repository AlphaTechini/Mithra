import { z } from 'zod';
import { DecimalString } from '../decimal';
import { PartyRefSchema, TxLinkSchema } from './treasury';

/**
 * MainNet payouts (M10). Mithra's records stay on the LocalNet ledger; on MainNet the money moves
 * as plain CC transfers the treasurer signs in Grofty Wallet. The server never moves MainNet funds
 * and the browser submits nothing to Canton except those transfers, to the receivers and amounts
 * listed here.
 */

/** One transfer the treasurer signs in Grofty Wallet. */
export const MainnetPayoutStatusSchema = z.enum(['to-sign', 'paid', 'awaiting-acceptance']);
export type MainnetPayoutStatus = z.infer<typeof MainnetPayoutStatusSchema>;

export const MainnetPayoutSchema = z.object({
  /** Opaque id of the payment; send it back to record the transfer. */
  paymentId: z.string(),
  holder: PartyRefSchema,
  /** The holder's MainNet party id (registered by connecting Grofty). */
  receiver: z.string(),
  amount: DecimalString,
  /** The memo to put on the transfer: "Mithra <fund name> <cycle label>". */
  memo: z.string(),
  status: MainnetPayoutStatusSchema,
  /** The MainNet explorer link, once the transfer is recorded. */
  link: TxLinkSchema.nullable(),
});
export type MainnetPayout = z.infer<typeof MainnetPayoutSchema>;

/** GET /api/cycles/:cycleId/mainnet-payouts (treasurer). */
export const MainnetPayoutsResponseSchema = z.object({
  assetSymbol: z.string(),
  total: DecimalString,
  /** The Mandate's fee buffer; the wallet must hold `total + feeBuffer` (P5). */
  feeBuffer: DecimalString,
  payouts: z.array(MainnetPayoutSchema),
});
export type MainnetPayoutsResponse = z.infer<typeof MainnetPayoutsResponseSchema>;

/**
 * How Grofty reported the transfer, as the browser read it:
 * `completed` the receiver holds the funds, `pending` the receiver has to accept an offer,
 * `unknown` Grofty executed the transfer but the outcome could not be read (recorded as not yet
 * confirmed, like `pending`: only `completed` is Paid).
 */
export const MainnetTransferOutcomeSchema = z.enum(['completed', 'pending', 'unknown']);
export type MainnetTransferOutcome = z.infer<typeof MainnetTransferOutcomeSchema>;

/** POST /api/cycles/:cycleId/mainnet-payouts/:paymentId (treasurer). Response: the list, updated. */
export const RecordMainnetPayoutRequestSchema = z.object({
  /** The update id Grofty returned from `prepareExecuteAndWait`. */
  updateId: z.string().trim().min(1).max(300),
  outcome: MainnetTransferOutcomeSchema,
});
export type RecordMainnetPayoutRequest = z.infer<typeof RecordMainnetPayoutRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Holder's MainNet wallet

/** POST /api/me/mainnet-wallet/challenge (holder): the message the wallet signs. */
export const MainnetWalletChallengeResponseSchema = z.object({
  nonce: z.string(),
  message: z.string(),
});
export type MainnetWalletChallengeResponse = z.infer<typeof MainnetWalletChallengeResponseSchema>;

/**
 * POST /api/me/mainnet-wallet (holder). `publicKey` and `signature` are base64 or hex; the
 * signature is Ed25519 over the UTF-8 bytes of the challenge message. Response: the holder's position.
 */
export const RegisterMainnetWalletRequestSchema = z.object({
  partyId: z.string().trim().min(1).max(300),
  publicKey: z.string().trim().min(1).max(500),
  signature: z.string().trim().min(1).max(1000),
  nonce: z.string().trim().min(1).max(200),
});
export type RegisterMainnetWalletRequest = z.infer<typeof RegisterMainnetWalletRequestSchema>;

/** A holder's registered MainNet wallet. */
export const MainnetWalletSchema = z.object({ partyId: z.string() });
export type MainnetWallet = z.infer<typeof MainnetWalletSchema>;
