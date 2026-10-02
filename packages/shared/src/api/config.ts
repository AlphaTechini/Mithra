import { z } from 'zod';
import { NetworkSchema } from '../network';

/** GET /api/config/public: what the browser needs to know about the deployment. */
export const PublicConfigSchema = z.object({
  network: NetworkSchema,
  testMode: z.boolean(),
  /** How payouts move money: on the records ledger (LocalNet), or as MainNet transfers signed in Grofty. */
  payoutRail: z.enum(['ledger', 'grofty-mainnet']),
  /** Display symbol of the distribution asset, e.g. "CC". */
  assetSymbol: z.string(),
  /** MainNet explorer link template containing "{updateId}"; null on LocalNet (links go to the in-app detail). */
  explorerTxUrlTemplate: z.string().nullable(),
  /** Minimum Grofty Wallet version the MainNet flow needs. */
  groftyMinVersion: z.string(),
  /** Public URL of the 3-minute demo video (the landing page's secondary button); null hides the button. */
  demoVideoUrl: z.string().nullable(),
});
export type PublicConfig = z.infer<typeof PublicConfigSchema>;
