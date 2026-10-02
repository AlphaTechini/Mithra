import type { TxLink } from '@mithra/shared';
import type { Config } from '../config/env';

/**
 * The link for a payment's transaction (P3). MainNet: the block explorer
 * (`MAINNET_EXPLORER_TX_URL` with `{updateId}`), opened in a new tab. LocalNet has no public
 * explorer, so the link is the in-app transaction page `/app/tx/<updateId>`.
 */
export function txLinkFor(config: Pick<Config, 'network' | 'mainnet'>, updateId: string): TxLink {
  if (config.network === 'mainnet' && config.mainnet) {
    return {
      updateId,
      href: config.mainnet.explorerTxUrl.replace('{updateId}', encodeURIComponent(updateId)),
      external: true,
    };
  }
  return { updateId, href: `/app/tx/${encodeURIComponent(updateId)}`, external: false };
}
