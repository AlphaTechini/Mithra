import type { HoldersResponse } from '@mithra/shared';
import type { Config } from '../config/env';
import type { Ledger } from '../ledger';
import type { PartyNames } from '../parties/names';
import type { AutoReceiveStatus } from './autoReceive';
import type { MainnetWalletLookup } from '../mainnet/wallets';
import { buildHoldersResponse } from './table';

export interface HoldersReaderDeps {
  config: Pick<Config, 'ledger'>;
  ledger: Pick<Ledger, 'reader'>;
  names: Pick<PartyNames, 'name'>;
  autoReceive: Pick<AutoReceiveStatus, 'getMany'>;
  /** MainNet: shows each holder's connected Grofty wallet in the table. */
  wallets?: Pick<MainnetWalletLookup, 'all'>;
}

/**
 * The holders table (userflow 5) as `GET /api/holders` and the agent's `list_holders` show it:
 * units and shares from the register, acceptance from the FundUnits (when the ledger user may read
 * them), last payments, and auto-receive from the registry.
 */
export function createHoldersReader(deps: HoldersReaderDeps): () => Promise<HoldersResponse> {
  const { reader } = deps.ledger;
  /** The agent can read FundUnits (and so see acceptance) only when it may read as the treasury. */
  const fundUnitsReadable = deps.config.ledger.readAsTreasury;
  return async () => {
    const [register, fundUnits, payments] = await Promise.all([
      reader.register(),
      fundUnitsReadable ? reader.fundUnits() : Promise.resolve([]),
      reader.payments(),
    ]);
    const changes = register?.payload.changes ?? [];
    const holderIds = [...new Set(changes.map((c) => c.holder))];
    const [nameList, status, wallets] = await Promise.all([
      Promise.all(holderIds.map((h) => deps.names.name(h))),
      deps.autoReceive.getMany(holderIds),
      deps.wallets ? deps.wallets.all() : Promise.resolve(null),
    ]);
    return buildHoldersResponse({
      changes,
      fundUnits,
      fundUnitsReadable,
      payments,
      names: new Map(holderIds.map((h, i) => [h, nameList[i] ?? h])),
      autoReceive: status,
      ...(wallets ? { mainnetWallets: wallets } : {}),
    });
  };
}
