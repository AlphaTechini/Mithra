import { Cron } from 'croner';
import { cycleLabel as labelOf, int } from './format';

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

/** `date` ("YYYY-MM-DD") minus `days` days. */
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

/**
 * The record date for a cycle by the policy's rule. The payment date is the first schedule run
 * after the cycle month ends (the 1st of the next month at 09:00 for `0 9 1 * *`).
 * - `last_day_of_previous_month`: the last day of the month before the payment date, which is the
 *   last day of the cycle month;
 * - `day_before_payment`: the day before the payment date. Without a schedule the payment date is
 *   the first of the next month, so this is also the last day of the cycle month.
 */
export function recordDateFor(rule: RecordDateRule, cycleId: string, schedule?: Schedule): string {
  const lastDay = lastDayOfCycleMonth(cycleId);
  if (rule === 'last_day_of_previous_month' || !schedule) return lastDay;
  const monthEnd = new Date(`${lastDay}T23:59:59.999Z`);
  const payment = nextRun(schedule.cron, schedule.tz, monthEnd);
  if (!payment) return lastDay;
  return addDays(localDate(payment, schedule.tz), -1);
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
