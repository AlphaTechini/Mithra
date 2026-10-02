import { createHash } from 'node:crypto';
import { sumDecimals, type HolderPosition, type TxLink } from '@mithra/shared';
import type { Config } from '../config/env';
import type { Contract, MithraPayloads } from '../ledger';
import { netUnits, sharePct, totalUnitsOf } from './table';

/**
 * The id a holder's client sees for a payment or a unit tranche: a hash of the contract id, 32 hex
 * characters. Contract ids are long (over 100 characters), which does not fit a URL path
 * parameter, and the hash keeps ledger ids out of the API. It is only ever resolved among the
 * contracts of the signed-in holder.
 */
export function opaqueId(contractId: string): string {
  return createHash('sha256').update(contractId).digest('hex').slice(0, 32);
}

/**
 * The link to a payment's transaction (P3): the network explorer on MainNet, the in-app detail
 * page on LocalNet. Holders get `/holder/tx/<updateId>` (the treasury team uses `/app/tx/...`).
 */
export function txLinkFor(config: Config, updateId: string): TxLink {
  if (config.network === 'mainnet') {
    return {
      updateId,
      href: config.mainnet.explorerTxUrl.replace('{updateId}', encodeURIComponent(updateId)),
      external: true,
    };
  }
  return { updateId, href: `/holder/tx/${encodeURIComponent(updateId)}`, external: false };
}

export interface PositionInput {
  config: Config;
  orgName: string;
  /** The signed-in holder. Everything below must already be limited to this party. */
  holder: string;
  /** The unit register's changes: only this holder's number and the fund's total are used. */
  changes: MithraPayloads['UnitRegister']['changes'];
  /** FundUnits read as the holder. */
  fundUnits: readonly Contract<MithraPayloads['FundUnit']>[];
  /** Payments read as the holder. */
  payments: readonly Contract<MithraPayloads['Payment']>[];
  /** Update ids by Payment contract id, from `tx_refs`. */
  updateIds: ReadonlyMap<string, string>;
  /** ISO date or time of the next cycle, or null. Only the date is kept. */
  nextPayment: string | null;
  autoReceive: boolean | null;
}

/**
 * The holder's own position (userflow 6). Pure: the caller supplies contracts that the ledger
 * already restricted to this holder; as a second guard, anything not owned by `holder` is dropped
 * here, so this function can never put another holder's data in a response.
 */
export function buildPosition(input: PositionInput): HolderPosition {
  const { holder } = input;
  const all = netUnits(input.changes);
  const units = all.get(holder) ?? 0;
  const own = input.payments.filter((p) => p.payload.holder === holder);

  const payments = [...own]
    .sort((a, b) => (a.payload.executedAt < b.payload.executedAt ? 1 : -1))
    .map((p) => {
      // MainNet payments name their transaction themselves (`externalTxRef`, the Grofty update id).
      const updateId = input.updateIds.get(p.contractId) ?? p.payload.externalTxRef;
      return {
        paymentId: opaqueId(p.contractId),
        cycleLabel: p.payload.cycleLabel,
        amount: p.payload.amount,
        status:
          p.payload.status === 'Paid'
            ? ('paid' as const)
            : p.payload.status === 'PendingExternal'
              ? ('pending' as const)
              : ('awaiting-acceptance' as const),
        at: p.payload.executedAt,
        link: updateId ? txLinkFor(input.config, updateId) : null,
        seeded: p.payload.seeded,
      };
    });

  return {
    orgName: input.orgName,
    assetSymbol: input.config.asset.symbol,
    units,
    sharePct: sharePct(units, totalUnitsOf(all)),
    totalReceived: sumDecimals(
      own.filter((p) => p.payload.status === 'Paid').map((p) => p.payload.amount),
    ),
    nextPaymentDate: input.nextPayment ? input.nextPayment.slice(0, 10) : null,
    autoReceive: input.autoReceive,
    pendingUnits: input.fundUnits
      .filter((u) => u.payload.holder === holder && !u.payload.accepted)
      .map((u) => ({
        unitId: opaqueId(u.contractId),
        units: u.payload.units,
        effectiveDate: u.payload.effectiveDate,
      })),
    payments,
  };
}
