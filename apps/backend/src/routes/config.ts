import { PublicConfigSchema, type PublicConfig } from '@mithra/shared';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config/env';

const DEFAULT_GROFTY_MIN_VERSION = '2.0.4';

export function publicConfig(config: Config): PublicConfig {
  return PublicConfigSchema.parse({
    network: config.network,
    // Records live on LocalNet on both networks; the role switcher is how people act on them.
    testMode: true,
    payoutRail: config.network === 'mainnet' ? 'grofty-mainnet' : 'ledger',
    assetSymbol: config.asset.symbol,
    explorerTxUrlTemplate: config.network === 'mainnet' ? config.mainnet.explorerTxUrl : null,
    groftyMinVersion:
      config.network === 'mainnet' ? config.mainnet.groftyMinVersion : DEFAULT_GROFTY_MIN_VERSION,
  });
}

export function configRoutes(app: FastifyInstance, config: Config): void {
  app.get('/api/config/public', (): PublicConfig => publicConfig(config));
}
