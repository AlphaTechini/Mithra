import { Cron } from 'croner';
import { cycleLabel as labelOf, int } from './format';

/**
 * `last_day_of_previous_month` is the last day of the month before the payment date, which is the
 * cycle's own month (a September cycle paid on October 1 has the record date September 30).
 */
export type RecordDateRule = 'last_day_of_previous_month' | 'day_before_payment';

const CYCLE_ID = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** True for a cycle id of the form `YYYY-MM` (the month whose yield is distributed). */
export function isCycleId(value: string): boolean {
  return CYCLE_ID.test(value);
}

function parseCycleId(cycleId: string): { year: number; month: number } {
  const match = CYCLE_ID.exec(cycleId);
  if (!match) throw new RangeError(`"${cycleId}" is not a cycle id like 2026-09`);
  return { year: int(match[1] ?? ''), month: int(match[2] ?? '') };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** The cycle id of the month containing `date` (UTC). */
export function cycleIdOfDate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
}

/** Default cycle for "Run cycle now": the previous calendar month in UTC. */
export function defaultCycleId(now: Date): string {
  return cycleIdOfDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
}

/** `2026-09` -> `September 2026`. */
export function cycleLabel(cycleId: string): string {
  return labelOf(cycleId);
}

/** The last day of the cycle month, `2026-09-30`. */
export function lastDayOfCycleMonth(cycleId: string): string {
  const { year, month } = parseCycleId(cycleId);
  const last = new Date(Date.UTC(year, month, 0));
  return `${last.getUTCFullYear()}-${pad(last.getUTCMonth() + 1)}-${pad(last.getUTCDate())}`;
}

/** The first day of the cycle month, `2026-09-01`. */
export function firstDayOfCycleMonth(cycleId: string): string {
  const { year, month } = parseCycleId(cycleId);
  return `${String(year).padStart(4, '0')}-${pad(month)}-01`;
}

/** `date` ("YYYY-MM-DD") plus `days` days (negative for earlier). */
export function addDays(date: string, days: number): string {
  const [y = 0, m = 1, d = 1] = date.split('-').map(int);
  const result = new Date(Date.UTC(y, m - 1, d + days));
  return `${result.getUTCFullYear()}-${pad(result.getUTCMonth() + 1)}-${pad(result.getUTCDate())}`;
}

/** Today's date, "YYYY-MM-DD", in UTC. */
export function isoDateOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The calendar date of `instant` in the time zone `tz`, "YYYY-MM-DD". */
function localDate(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** The next time `cron` fires in `tz` after `from`, or null when it never does. */
export function nextRun(cron: string, tz: string, from: Date): Date | null {
  return new Cron(cron, { timezone: tz }).nextRun(from);
}

/** Throws a readable error when the cron expression or time zone is not valid. */
export function assertSchedule(cron: string, tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch (error) {
    throw new RangeError(`"${tz}" is not a time zone. Use a name like UTC or Europe/Zurich.`, {
      cause: error,
    });
  }
  try {
    new Cron(cron, { timezone: tz, paused: true });
  } catch (error) {
    throw new RangeError(
      `"${cron}" is not a valid schedule (${error instanceof Error ? error.message : 'unknown error'}). Use five fields like 0 9 1 * *.`,
      { cause: error },
    );
  }
}

export interface Schedule {
  cron: string;
  tz: string;
}

/** More than the runs of an every-minute schedule between the earliest and latest month end. */
const MAX_RUNS_SCANNED = 2000;

/**
 * The payment run of a cycle: the first schedule run whose date in `schedule.tz` is after the
 * cycle month. Local midnight of the 1st of the next month is earliest in UTC+14 (10:00 UTC on
 * the last day of the cycle month), so the search starts just before that and skips runs that are
 * still inside the cycle month where the schedule's time zone is behind UTC. Null when there is
 * none.
 */
export function paymentRunFor(cycleId: string, schedule: Schedule): Date | null {
  const lastDay = lastDayOfCycleMonth(cycleId);
  let from = new Date(`${lastDay}T09:59:59.999Z`);
  for (let scanned = 0; scanned < MAX_RUNS_SCANNED; scanned += 1) {
    const run = nextRun(schedule.cron, schedule.tz, from);
    if (!run) return null;
    if (localDate(run, schedule.tz) > lastDay) return run;
    from = run;
  }
  return null;
}

/**
 * The record date for a cycle by the policy's rule. The payment date is the first schedule run
 * after the cycle month ends (the 1st of the next month at 09:00 for `0 9 1 * *`).
 * - `last_day_of_previous_month`: the last day of the month before the payment date, which is the
 *   last day of the cycle month;
 * - `day_before_payment`: the day before the payment date, kept inside the cycle month because the
 *   ledger accepts only record dates inside it (`Mandate_Propose`). Without a schedule the payment
 *   date is the first of the next month, so this is also the last day of the cycle month. The
 *   payment run is found by its local date in the schedule's time zone (`paymentRunFor`), not by
 *   the UTC month end.
 */
export function recordDateFor(rule: RecordDateRule, cycleId: string, schedule?: Schedule): string {
  const lastDay = lastDayOfCycleMonth(cycleId);
  if (rule === 'last_day_of_previous_month' || !schedule) return lastDay;
  const payment = paymentRunFor(cycleId, schedule);
  if (!payment) return lastDay;
  const dayBefore = addDays(localDate(payment, schedule.tz), -1);
  return dayBefore < firstDayOfCycleMonth(cycleId)
    ? firstDayOfCycleMonth(cycleId)
    : dayBefore > lastDay
      ? lastDay
      : dayBefore;
}

/**
 * Why `recordDate` is not allowed for the cycle under `rule`, or null when it is. This is the rule
 * the ledger enforces in `Mandate_Propose`: the last day of the cycle month for
 * `last_day_of_previous_month`, any day inside the cycle month for `day_before_payment`.
 */
export function recordDateProblem(
  rule: RecordDateRule,
  cycleId: string,
  recordDate: string,
): string | null {
  const lastDay = lastDayOfCycleMonth(cycleId);
  if (rule === 'last_day_of_previous_month') {
    return recordDate === lastDay
      ? null
      : `The record date must be the last day of ${cycleId}, ${lastDay}.`;
  }
  return recordDate >= firstDayOfCycleMonth(cycleId) && recordDate <= lastDay
    ? null
    : `The record date must fall inside ${cycleId}, between ${firstDayOfCycleMonth(cycleId)} and ${lastDay}.`;
}

/**
 * The cycle a scheduled run at `runAt` distributes: the month before the run (a run on October 1
 * pays September).
 */
export function cycleIdForRun(runAt: Date, tz: string): string {
  const local = localDate(runAt, tz);
  const [year = 0, month = 1] = local.split('-').map(int);
  return cycleIdOfDate(new Date(Date.UTC(year, month - 2, 1)));
}
