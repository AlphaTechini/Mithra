import type { HolderRow, HoldersResponse } from '@mithra/shared';
import Decimal from 'decimal.js';
import type { Contract, MithraPayloads } from '../ledger';

// A dedicated Decimal class so global Decimal settings can never leak into percentage maths.
const PctDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

type UnitChange = MithraPayloads['UnitRegister']['changes'][number];

/** Net units per holder from the register's changes. Holders with no units left are left out. */
export function netUnits(changes: readonly UnitChange[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const change of changes) {
    totals.set(change.holder, (totals.get(change.holder) ?? 0) + change.delta);
  }
  for (const [holder, units] of totals) if (units <= 0) totals.delete(holder);
  return totals;
}

/** Sum of all positive balances. */
export function totalUnitsOf(units: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const value of units.values()) total += value;
  return total;
}

/**
 * `units` as a share of `total`, as a percentage string with 2 decimals ("33.33"). Rounded half
 * even with decimal.js. "0.00" when there are no units at all.
 */
export function sharePct(units: number, total: number): string {
  if (total <= 0 || units <= 0) return '0.00';
  return new PctDecimal(units).mul(100).div(total).toFixed(2, Decimal.ROUND_HALF_EVEN);
}

export interface HoldersTableInput {
  changes: readonly UnitChange[];
  /** Every FundUnit the reader could see. Empty when `fundUnitsReadable` is false. */
  fundUnits: readonly Contract<MithraPayloads['FundUnit']>[];
  /**
   * True when the reader can see FundUnits (LocalNet: the agent reads as the treasury). When it
   * cannot, acceptance is unknown and every holder shows as not yet accepted: the table never
   * claims an acceptance it cannot see.
   */
  fundUnitsReadable: boolean;
  payments: readonly Contract<MithraPayloads['Payment']>[];
  /** Display names by party id. */
  names: ReadonlyMap<string, string>;
  /** Auto-receive status by party id; missing or null when it could not be determined. */
  autoReceive: ReadonlyMap<string, boolean | null>;
}

/** The holders table (userflow 5): units, share, auto-receive, acceptance, last payment. */
export function buildHoldersResponse(input: HoldersTableInput): HoldersResponse {
  const units = netUnits(input.changes);
  const total = totalUnitsOf(units);

  const rows: HolderRow[] = [];
  for (const [holder, held] of units) {
    const changes = input.changes.filter((c) => c.holder === holder);
    const unaccepted = input.fundUnits.some(
      (u) => u.payload.holder === holder && !u.payload.accepted,
    );
    const hasFundUnit = input.fundUnits.some((u) => u.payload.holder === holder);
    const lastPayment =
      input.payments
        .filter((p) => p.payload.holder === holder)
        .sort((a, b) => (a.payload.executedAt < b.payload.executedAt ? 1 : -1))[0]?.payload ?? null;
    rows.push({
      holder: { partyId: holder, displayName: input.names.get(holder) ?? holder },
      units: held,
      sharePct: sharePct(held, total),
      autoReceive: input.autoReceive.get(holder) ?? null,
      unitsAccepted: input.fundUnitsReadable && hasFundUnit && !unaccepted,
      lastPayment: lastPayment
        ? {
            amount: lastPayment.amount,
            at: lastPayment.executedAt,
            cycleLabel: lastPayment.cycleLabel,
          }
        : null,
      // Seeded only while every change of the holder came from seeding.
      seeded: changes.length > 0 && changes.every((c) => c.seeded),
    });
  }
  rows.sort(
    (a, b) => b.units - a.units || a.holder.displayName.localeCompare(b.holder.displayName),
  );
  return { totalUnits: total, holders: rows };
}
