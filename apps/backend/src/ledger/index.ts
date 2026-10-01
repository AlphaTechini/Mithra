import type { Config } from '../config/env';
import { createTokenProvider, type TokenProvider } from './auth';
import { LedgerClient } from './client';
import { createMithraCommands } from './mithra/commands';
import { MithraReader } from './mithra/queries';
import { mithraTemplateIds } from './mithra/templates';

export * from './types';
export * from './errors';
export * from './auth';
export * from './codec';
export { LedgerClient, createdIn, exerciseResultOf, parseTransaction } from './client';
export * from './mithra';

/** The ledger module: the only way the application talks to the ledger. */
export type Ledger = ReturnType<typeof createLedger>;

/** What `createLedger` needs from the configuration. */
export type LedgerConfig = Pick<Config, 'ledger' | 'parties'>;

export function createLedger(
  config: LedgerConfig,
  options: { tokens?: TokenProvider; fetch?: typeof fetch } = {},
) {
  const tokens = options.tokens ?? createTokenProvider(config.ledger.auth, config.ledger.userId);
  const client = new LedgerClient({
    baseUrl: config.ledger.jsonApiUrl,
    userId: config.ledger.userId,
    tokens,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const templates = mithraTemplateIds(config.ledger.mithraPackage);
  const readParties = config.ledger.readAsTreasury
    ? [config.parties.agent, config.parties.treasury]
    : [config.parties.agent];
  const reader = new MithraReader({
    client,
    templates,
    treasuryParty: config.parties.treasury,
    readParties,
  });
  const commands = createMithraCommands(templates);
  return { client, reader, commands, templates };
}
