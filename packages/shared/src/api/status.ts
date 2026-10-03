import { z } from 'zod';

/** One LocalNet participant node as reported by GET /api/status. */
export const NodeStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  operator: z.string(),
  /** True when the node's JSON Ledger API answered /v2/version within the timeout. */
  ok: z.boolean(),
});
export type NodeStatus = z.infer<typeof NodeStatusSchema>;

/** GET /api/status: reachability of the ledger, the database and (LocalNet) every node. */
export const StatusResponseSchema = z.object({
  ledger: z.object({
    ok: z.boolean(),
    version: z.string().optional(),
    error: z.string().optional(),
  }),
  database: z.object({ ok: z.boolean() }),
  /** LocalNet only: one entry per configured node. */
  nodes: z.array(NodeStatusSchema).optional(),
});
export type StatusResponse = z.infer<typeof StatusResponseSchema>;
