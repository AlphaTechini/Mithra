import { z } from 'zod';
import { NetworkSchema } from '../network';

/** GET /api/config/public: what the browser needs to know about the deployment. */
export const PublicConfigSchema = z.object({
  network: NetworkSchema,
  testMode: z.boolean(),
  /** Display symbol of the distribution asset, e.g. "CC". */
  assetSymbol: z.string(),
  /** MainNet explorer link template containing "{updateId}"; null on LocalNet (links go to the in-app detail). */
  explorerTxUrlTemplate: z.string().nullable(),
  /** Minimum Grofty Wallet version the MainNet flow needs. */
  groftyMinVersion: z.string(),
});
export type PublicConfig = z.infer<typeof PublicConfigSchema>;
