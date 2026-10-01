import { toDecimal } from '@mithra/shared';
import type { CheckResult, Payout } from '../ledger';
import {
  D,
  formatAmount,
  formatRounded,
  formatSignedPct,
  plural,
  shortDate,
  showAmountText,
} from './format';
import { cycleLabel as labelOf } from './period';
import { addDays } from './period';
import { unitsAt, type Holding, type UnitChangeLike } from './prorata';

/**
 * The deterministic checks of details.md section 7. Every check is a pure function of values the
 * engine read from the ledger and the registry; no language model is involved (A4). Each result
 * carries the actual values in the words of userflow.md section 9.
 *
 * Blocking rules:
 * - `cap`, `non_holder`, `duplicate_cycle`, `deviation`, `unit_spike` and `prompt_amount` are
 *   blocking: a failed one forces the verdict `NeedsApproval` (the Mandate computes the verdict).
 * - `balance` is deliberately NOT blocking. An empty treasury is not a reason to ask approvers; it
 *   is a reason to ask for funds. The engine never executes while the live balance is below
 *   total plus fee buffer (status `needs-funds`, P5), whatever the verdict.
 */

export type CheckTrigger = 'schedule' | 'prompt' | 'manual';

type Draft = Omit<CheckResult, 'source'>;

function result(draft: Draft): CheckResult {
  return { ...draft, source: 'deterministic' };
}

/** The total is at or under the auto-execute cap. */
export function checkCap(input: { total: string; cap: string; symbol: string }): CheckResult {
  const passed = toDecimal(input.total).lte(toDecimal(input.cap));
  return result({
    code: 'cap',
    label: 'Within the auto-execute cap',
    passed,
    blocking: true,
    actual: `Total ${formatAmount(input.total, input.symbol)} vs cap ${formatAmount(input.cap, input.symbol)}`,
    limit: `At most ${formatAmount(input.cap, input.symbol)}`,
  });
}

/** The treasury balance covers the total plus the fee buffer (non-blocking, see above). */
export function checkBalance(input: {
  total: string;
  feeBuffer: string;
  balance: string;
  symbol: string;
}): CheckResult {
  const required = toDecimal(input.total).plus(toDecimal(input.feeBuffer));
  const passed = toDecimal(input.balance).gte(required);
  return result({
    code: 'balance',
    label: 'Treasury balance covers the total and fees',
    passed,
    blocking: false,
    actual: `Balance ${formatAmount(input.balance, input.symbol)} vs ${formatAmount(required, input.symbol)} needed (${formatAmount(input.total, input.symbol)} plus ${formatAmount(input.feeBuffer, input.symbol)} fee buffer)`,
    limit: `At least ${formatAmount(required, input.symbol)}`,
  });
}

/** Every payee held units on the record date. */
export function checkNonHolder(input: {
  payouts: readonly Pick<Payout, 'holder'>[];
  holdingsOnRecordDate: readonly Holding[];
  recordDate: string;
  nameOf: (party: string) => string;
}): CheckResult {
  const held = new Set(input.holdingsOnRecordDate.filter((h) => h.units > 0).map((h) => h.holder));
  const missing = input.payouts
    .filter((p) => !held.has(p.holder))
    .map((p) => input.nameOf(p.holder));
  const on = shortDate(input.recordDate);
  return result({
    code: 'non_holder',
    label: 'Every payee held units on the record date',
    passed: missing.length === 0,
    blocking: true,
    actual:
      missing.length === 0
        ? `${input.payouts.length} of ${plural(input.payouts.length, 'payee')} held units on ${on}`
        : `${missing.join(', ')} did not hold units on ${on}`,
    limit: 'Every payee must have held units on the record date',
  });
}

/** No distribution exists yet for this cycle. */
export function checkDuplicateCycle(input: {
  cycleId: string;
  alreadyExecuted: boolean;
}): CheckResult {
  const label = labelOf(input.cycleId);
  return result({
    code: 'duplicate_cycle',
    label: 'No distribution yet for this cycle',
    passed: !input.alreadyExecuted,
    blocking: true,
    actual: input.alreadyExecuted
      ? `A distribution for ${label} has already been executed`
      : `No distribution exists for ${label}`,
    limit: 'One distribution per cycle',
  });
}

export interface HistoryEntry {
  cycleId: string;
  /** Total of an executed cycle, a decimal string. */
  total: string;
}

/** The last `count` executed cycles before `cycleId`, newest first. */
export function selectHistory(
  executed: readonly HistoryEntry[],
  cycleId: string,
  count: number,
): HistoryEntry[] {
  const seen = new Set<string>();
  return [...executed]
    .filter((e) => e.cycleId < cycleId)
    .sort((a, b) => (a.cycleId < b.cycleId ? 1 : a.cycleId > b.cycleId ? -1 : 0))
    .filter((e) => (seen.has(e.cycleId) ? false : (seen.add(e.cycleId), true)))
    .slice(0, Math.max(count, 0));
}

/** The total is within `deviationPct` percent of the trailing average of earlier executed cycles. */
export function checkDeviation(input: {
  total: string;
  /** The cycles to average, already selected with `selectHistory`. */
  history: readonly HistoryEntry[];
  deviationPct: string;
  symbol: string;
}): CheckResult {
  const limitText = `At most ${showAmountText(input.deviationPct)}% from the trailing average`;
  const base = {
    code: 'deviation',
    label: 'Total is in line with earlier cycles',
    blocking: true,
  } as const;
  const sum = input.history.reduce((acc, h) => acc.plus(toDecimal(h.total)), new D(0));
  if (input.history.length === 0 || !sum.gt(0)) {
    return result({
      ...base,
      passed: true,
      actual: 'No earlier cycles to compare',
      limit: limitText,
    });
  }
  const average = sum.div(input.history.length);
  const total = toDecimal(input.total);
  const diff = new D(total).minus(average);
  // |total - average| * 100 > deviationPct * average, without dividing, so the decision is exact.
  const exceeds = diff.abs().times(100).gt(toDecimal(input.deviationPct).times(average));
  const pct = diff.times(100).div(average);
  return result({
    ...base,
    passed: !exceeds,
    actual: `Total ${formatAmount(input.total, input.symbol)} vs ${input.history.length}-cycle average ${formatAmount(formatRounded(average, 2), input.symbol)}, ${formatSignedPct(pct)}`,
    limit: `At most ${showAmountText(input.deviationPct)}% from the ${input.history.length}-cycle average`,
  });
}

interface Spike {
  holder: string;
  before: number;
  after: number;
  /** Percent change, or null for a holder who had no units at the start of the window. */
  pct: ReturnType<typeof pctChange>;
}

function pctChange(before: number, after: number): InstanceType<typeof D> | null {
  if (before === 0) return null;
  return new D(after - before).times(100).div(before);
}

/**
 * No holder's units changed by more than `unitChangePct` percent in the `windowDays` days before
 * the record date. A holder who went from 0 units to some units inside the window counts as a
 * spike whatever the percentage.
 */
export function checkUnitSpike(input: {
  changes: readonly UnitChangeLike[];
  recordDate: string;
  windowDays: number;
  unitChangePct: string;
  nameOf: (party: string) => string;
}): CheckResult {
  const start = addDays(input.recordDate, -input.windowDays);
  const before = new Map(unitsAt(start, input.changes).map((h) => [h.holder, h.units]));
  const after = new Map(unitsAt(input.recordDate, input.changes).map((h) => [h.holder, h.units]));
  const holders = [...new Set([...before.keys(), ...after.keys()])].sort();
  const window = `in the ${plural(input.windowDays, 'day')} before ${shortDate(input.recordDate)}`;
  const threshold = toDecimal(input.unitChangePct);
  const changed: Spike[] = [];
  for (const holder of holders) {
    const b = before.get(holder) ?? 0;
    const a = after.get(holder) ?? 0;
    if (a !== b) changed.push({ holder, before: b, after: a, pct: pctChange(b, a) });
  }
  const describe = (s: Spike): string => {
    const units = `${showAmountText(String(s.before))} → ${showAmountText(String(s.after))} ${s.after === 1 ? 'unit' : 'units'}`;
    const change = s.pct === null ? 'new holder' : formatSignedPct(s.pct);
    return `${input.nameOf(s.holder)}: ${units} (${change}) ${window}`;
  };
  const spikes = changed.filter((s) => s.pct === null || s.pct.abs().gt(threshold));
  const limit = `No holder changes by more than ${showAmountText(input.unitChangePct)}% ${window}`;
  const base = {
    code: 'unit_spike',
    label: 'No sharp change in holder units',
    blocking: true,
  } as const;
  if (spikes.length > 0) {
    return result({ ...base, passed: false, actual: spikes.map(describe).join('; '), limit });
  }
  if (changed.length === 0) {
    return result({
      ...base,
      passed: true,
      actual: `No unit changes ${window}`,
      limit,
    });
  }
  const largest = changed.reduce((max, s) =>
    (s.pct?.abs() ?? new D(0)).gt(max.pct?.abs() ?? new D(0)) ? s : max,
  );
  return result({ ...base, passed: true, actual: `Largest change: ${describe(largest)}`, limit });
}

/**
 * The amount was not set by a prompt that differs from the policy's fixed amount. Not applicable
 * when the policy has no fixed amount or the cycle was not triggered by a prompt.
 */
export function checkPromptAmount(input: {
  trigger: CheckTrigger;
  total: string;
  fixedAmount: string | null;
  symbol: string;
}): CheckResult {
  const base = {
    code: 'prompt_amount',
    label: 'Amount matches the policy',
    blocking: true,
  } as const;
  if (input.fixedAmount === null || input.trigger !== 'prompt') {
    return result({
      ...base,
      passed: true,
      actual: 'Not applicable',
      limit:
        input.fixedAmount === null
          ? 'The policy has no fixed amount'
          : `The policy's fixed amount is ${formatAmount(input.fixedAmount, input.symbol)}`,
    });
  }
  const same = toDecimal(input.total).equals(toDecimal(input.fixedAmount));
  return result({
    ...base,
    passed: same,
    actual: same
      ? `Prompt amount ${formatAmount(input.total, input.symbol)} matches the policy's fixed amount`
      : `A prompt asked for ${formatAmount(input.total, input.symbol)}, the policy's fixed amount is ${formatAmount(input.fixedAmount, input.symbol)}`,
    limit: `Equal to the policy's fixed amount of ${formatAmount(input.fixedAmount, input.symbol)}`,
  });
}

export interface CheckInputs {
  symbol: string;
  nameOf: (party: string) => string;
  cycleId: string;
  recordDate: string;
  trigger: CheckTrigger;
  total: string;
  payouts: readonly Payout[];
  /** Units held on the record date. */
  holdingsOnRecordDate: readonly Holding[];
  /** The whole unit register, for the unit-change window. */
  changes: readonly UnitChangeLike[];
  terms: {
    cap: string;
    feeBuffer: string;
    deviationPct: string;
    trailingCycles: number;
    unitChangePct: string;
    unitChangeWindowDays: number;
    fixedAmount: string | null;
  };
  /** Live balance of the treasury, a decimal string. */
  balance: string;
  /** The Mandate or the ledger already records an executed distribution for this cycle. */
  alreadyExecuted: boolean;
  /** Executed cycles before this one, all of them; `runChecks` picks the trailing ones. */
  executedHistory: readonly HistoryEntry[];
}

/** All seven deterministic checks, in the order of details.md section 7. */
export function runChecks(input: CheckInputs): CheckResult[] {
  const history = selectHistory(input.executedHistory, input.cycleId, input.terms.trailingCycles);
  return [
    checkCap({ total: input.total, cap: input.terms.cap, symbol: input.symbol }),
    checkBalance({
      total: input.total,
      feeBuffer: input.terms.feeBuffer,
      balance: input.balance,
      symbol: input.symbol,
    }),
    checkNonHolder({
      payouts: input.payouts,
      holdingsOnRecordDate: input.holdingsOnRecordDate,
      recordDate: input.recordDate,
      nameOf: input.nameOf,
    }),
    checkDuplicateCycle({ cycleId: input.cycleId, alreadyExecuted: input.alreadyExecuted }),
    checkDeviation({
      total: input.total,
      history,
      deviationPct: input.terms.deviationPct,
      symbol: input.symbol,
    }),
    checkUnitSpike({
      changes: input.changes,
      recordDate: input.recordDate,
      windowDays: input.terms.unitChangeWindowDays,
      unitChangePct: input.terms.unitChangePct,
      nameOf: input.nameOf,
    }),
    checkPromptAmount({
      trigger: input.trigger,
      total: input.total,
      fixedAmount: input.terms.fixedAmount,
      symbol: input.symbol,
    }),
  ];
}
