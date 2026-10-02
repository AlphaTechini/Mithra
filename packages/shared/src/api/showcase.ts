import { z } from 'zod';
import { DecimalString } from '../decimal';

/**
 * GET /api/public/showcase (no sign-in): the landing page's live seal. Aggregate numbers of the
 * latest cycle that was approved and paid, and nothing else: no holder names, no party ids, no
 * per-holder amounts. `null` while no approved cycle has been paid.
 */
export const ShowcaseSchema = z
  .object({
    /** The cycle's label, for example "September 2026". */
    cycleLabel: z.string(),
    total: DecimalString,
    /** Asset symbol, for example "CC". */
    assetSymbol: z.string(),
    /** How many holders the distribution paid. */
    payees: z.number().int().nonnegative(),
    /**
     * Approvals the ledger counted, the threshold the Mandate required, and how many approvers the
     * fund has: "approved 2 of 3" is `have` 2 of `approvers` 3, and the seal ring has `need` segments.
     */
    approvals: z.object({
      have: z.number().int(),
      need: z.number().int(),
      approvers: z.number().int().positive(),
    }),
  })
  .nullable();
export type Showcase = z.infer<typeof ShowcaseSchema>;
