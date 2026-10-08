import type { Config } from '../config/env';
import { unsafeHmac } from '../ledger/auth';
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
  config: Pick<Config, 'asset' | 'registryUrl' | 'ledger'>,
  ledger: LedgerClient,
): AssetAdapter {
  // A LocalNet validator's scan-proxy needs the LocalNet token. Only unsafe-hmac (LocalNet only)
  // sends one, so a ledger token never goes to a public registry.
  const auth = config.ledger.auth;
  return createTokenStandardAdapter({
    ledger,
    registryUrl: config.registryUrl,
    ...(auth.mode === 'unsafe-hmac'
      ? {
          auth: unsafeHmac({
            secret: auth.secret,
            audience: auth.audience,
            userId: config.ledger.userId,
          }),
        }
      : {}),
    instrument: { admin: config.asset.adminParty, id: config.asset.id },
  });
}
