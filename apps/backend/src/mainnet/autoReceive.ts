import { AutoReceiveStatus } from '../holders/autoReceive';
import { lookupPreapproval } from './scan';
import type { MainnetWalletLookup } from './wallets';

/**
 * Auto-receive on MainNet: the holder's connected Grofty party is looked up in a public Scan
 * (`MAINNET_SCAN_URL`). `null` ("could not tell") when no Scan is configured, when the holder has
 * not connected a wallet yet, or when Scan does not answer.
 */
export function createMainnetAutoReceive(options: {
  scanUrl: string | undefined;
  wallets: Pick<MainnetWalletLookup, 'get'>;
  fetch?: typeof fetch;
  ttlMs?: number;
  now?: () => number;
  onError?: (holder: string, error: unknown) => void;
}): AutoReceiveStatus {
  const { scanUrl } = options;
  return new AutoReceiveStatus({
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    ...(options.now ? { now: options.now } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
    lookup: async (holder) => {
      if (!scanUrl) return null;
      const wallet = await options.wallets.get(holder);
      if (!wallet) return null;
      return lookupPreapproval(scanUrl, wallet.partyId, options.fetch);
    },
  });
}
