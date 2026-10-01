import type { Config } from '../config/env';
import type { LedgerClient } from '../ledger/client';
import type { AssetAdapter } from './assetAdapter';
import { createTokenStandardAdapter } from './tokenStandard';

export type {
  AssetAdapter,
  Holding,
  TransferKind,
  TransferLegInput,
  TransferLegResult,
} from './assetAdapter';
export { createTokenStandardAdapter, HOLDING_INTERFACE_ID, RegistryError } from './tokenStandard';

/** The asset adapter for the configured network. Both networks use the token standard registry. */
export function createAssetAdapter(
  config: Pick<Config, 'asset' | 'registryUrl'>,
  ledger: LedgerClient,
): AssetAdapter {
  return createTokenStandardAdapter({
    ledger,
    registryUrl: config.registryUrl,
    instrument: { admin: config.asset.adminParty, id: config.asset.id },
  });
}
