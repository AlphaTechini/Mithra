import type { SealStatus } from '@mithra/shared';
import type { Config } from '../config/env';
import { ApiError } from '../http/errors';
import { MAINNET_SIGNING_MESSAGE } from '../cycle/executor';
import {
  newSealId,
  prepareSeal,
  sealStatusOf,
  type MandateSealer,
  type SealPrepareDeps,
  type SealStore,
} from './sealer';

export interface MainnetSealerDeps extends SealPrepareDeps {
  config: Config;
  store: SealStore;
}

/**
 * MainNet: the treasurer is the treasury and signs the seal request in Grofty (M10). Until then a
 * seal request is recorded in the `awaiting-signature` state with a clear message.
 */
export function createMainnetSealer(deps: MainnetSealerDeps): MandateSealer {
  return {
    async start(draftId, treasurer): Promise<SealStatus> {
      const prepared = await prepareSeal(deps, draftId, treasurer);
      const row = await deps.store.insert({
        sealId: newSealId(),
        draftId,
        treasurer,
        sealRequestCid: null,
        governanceProposalCid: null,
        state: 'awaiting-signature',
        confirmations: {},
        baseVersion: prepared.organization.payload.mandateVersion,
        mandateVersion: null,
        error: MAINNET_SIGNING_MESSAGE,
      });
      return sealStatusOf(row, deps.config);
    },
    async status(sealId): Promise<SealStatus> {
      const row = await deps.store.get(sealId);
      if (!row) throw notFound(sealId);
      return sealStatusOf(row, deps.config);
    },
    async advance(sealId): Promise<SealStatus> {
      return this.status(sealId);
    },
    pending: () => Promise.resolve([]),
  };
}

function notFound(sealId: string): ApiError {
  return new ApiError(404, 'seal_not_found', `There is no seal request ${sealId}.`);
}
