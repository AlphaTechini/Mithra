import { RecordMainnetPayoutRequestSchema, type MainnetPayoutsResponse } from '@mithra/shared';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/roles';
import { ApiError, parse } from '../http/errors';
import type { MainnetPayouts } from './payouts';

const CycleParams = z.object({ cycleId: z.string().min(1).max(40) });
const PayoutParams = z.object({
  cycleId: z.string().min(1).max(40),
  paymentId: z.string().min(1).max(200),
});

/** The treasurer's MainNet payout routes (M10). */
export function mainnetRoutes(app: FastifyInstance, payouts: MainnetPayouts): void {
  const treasurerOnly = requireRole('treasurer');

  app.get(
    '/api/cycles/:cycleId/mainnet-payouts',
    { preHandler: treasurerOnly },
    async (request): Promise<MainnetPayoutsResponse> => {
      const { cycleId } = parse(CycleParams, request.params);
      return payouts.list(cycleId);
    },
  );

  app.post(
    '/api/cycles/:cycleId/mainnet-payouts/:paymentId',
    { preHandler: treasurerOnly },
    async (request): Promise<MainnetPayoutsResponse> => {
      const { cycleId, paymentId } = parse(PayoutParams, request.params);
      const body = parse(RecordMainnetPayoutRequestSchema, request.body);
      const actor = request.session?.partyId;
      if (!actor) throw new ApiError(401, 'not_signed_in', 'Sign in and pick a party first.');
      return payouts.record(cycleId, paymentId, body, actor);
    },
  );
}

/** The routes as a plugin, for `AppModules`. */
export function createMainnetRoutesPlugin(payouts: MainnetPayouts): FastifyPluginAsync {
  return (app) => {
    mainnetRoutes(app, payouts);
    return Promise.resolve();
  };
}
