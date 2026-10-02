import { StatusResponseSchema, type StatusResponse } from '@mithra/shared';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Config } from '../config/env';
import { pingDatabase } from '../db';
import type { Ledger } from '../ledger';

const NODE_TIMEOUT_MS = 2000;

export interface StatusDeps {
  ledger: Ledger;
  pool: pg.Pool;
}

export function statusRoutes(app: FastifyInstance, config: Config, deps: StatusDeps): void {
  app.get('/api/status', async (): Promise<StatusResponse> => {
    const ledgerCheck = deps.ledger.client
      .atUrl(config.ledger.jsonApiUrl, {
        timeoutMs: NODE_TIMEOUT_MS,
        retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      })
      .version()
      .then(
        (v) => ({ ok: true as const, version: v.version }),
        (error: unknown) => ({
          ok: false as const,
          error: error instanceof Error ? error.message : 'The ledger did not answer.',
        }),
      );
    const databaseCheck = pingDatabase(deps.pool);
    // The records ledger is LocalNet on both networks, so its nodes are checked on both.
    const nodeChecks = config.localnet.nodes.map(async (node) => {
      const client = deps.ledger.client.atUrl(node.jsonApiUrl, {
        timeoutMs: NODE_TIMEOUT_MS,
        retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      });
      const ok = await client.version().then(
        () => true,
        () => false,
      );
      return { id: node.id, name: node.name, operator: node.operator, ok };
    });
    const [ledger, databaseOk, nodes] = await Promise.all([
      ledgerCheck,
      databaseCheck,
      Promise.all(nodeChecks),
    ]);
    return StatusResponseSchema.parse({
      ledger,
      database: { ok: databaseOk },
      nodes,
    });
  });
}
