import { describe, expect, it } from 'vitest';
import {
  assertSchedule,
  cycleIdForRun,
  cycleIdOfDate,
  cycleLabel,
  defaultCycleId,
  isCycleId,
  lastDayOfCycleMonth,
  nextRun,
  recordDateFor,
  recordDateProblem,
} from './period';

describe('cycle ids', () => {
  it('labels the distributed month', () => {
    expect(cycleLabel('2026-09')).toBe('September 2026');
    expect(cycleLabel('2027-01')).toBe('January 2027');
  });

  it('defaults to the previous calendar month in UTC', () => {
    expect(defaultCycleId(new Date('2026-10-01T09:00:00Z'))).toBe('2026-09');
    expect(defaultCycleId(new Date('2027-01-15T00:00:00Z'))).toBe('2026-12');
    expect(defaultCycleId(new Date('2026-03-31T23:59:59Z'))).toBe('2026-02');
  });

  it('takes the cycle id of a date from its UTC month', () => {
    expect(cycleIdOfDate(new Date('2026-09-30T23:59:59Z'))).toBe('2026-09');
  });

  it('validates the format', () => {
    expect(isCycleId('2026-09')).toBe(true);
    expect(isCycleId('2026-13')).toBe(false);
    expect(isCycleId('2026-9')).toBe(false);
    expect(isCycleId('September')).toBe(false);
  });

  it('finds the last day of a month, including leap years', () => {
    expect(lastDayOfCycleMonth('2026-09')).toBe('2026-09-30');
    expect(lastDayOfCycleMonth('2026-12')).toBe('2026-12-31');
    expect(lastDayOfCycleMonth('2028-02')).toBe('2028-02-29');
    expect(lastDayOfCycleMonth('2026-02')).toBe('2026-02-28');
  });
});

describe('record date rules', () => {
  it('last_day_of_previous_month is the last day of the cycle month', () => {
    expect(recordDateFor('last_day_of_previous_month', '2026-09')).toBe('2026-09-30');
  });

  it('day_before_payment is the day before the first scheduled payment after the cycle month', () => {
    const monthly = { cron: '0 9 1 * *', tz: 'UTC' };
    expect(recordDateFor('day_before_payment', '2026-09', monthly)).toBe('2026-09-30');
  });

  it('day_before_payment stays inside the cycle month, which is all the ledger accepts', () => {
    // paid on the 15th of the next month: the day before is October 14, outside September
    const mid = { cron: '0 9 15 * *', tz: 'UTC' };
    expect(recordDateFor('day_before_payment', '2026-09', mid)).toBe('2026-09-30');
    // the first payment after the month ends is on November 1 in Auckland (UTC+13 in summer)
    const auckland = { cron: '0 9 1 * *', tz: 'Pacific/Auckland' };
    expect(recordDateFor('day_before_payment', '2026-09', auckland)).toBe('2026-09-30');
    // paid on the 30th at 17:00 in Los Angeles: the day before is still in the month
    const la = { cron: '0 17 30 * *', tz: 'America/Los_Angeles' };
    expect(recordDateFor('day_before_payment', '2026-09', la)).toBe('2026-09-29');
  });

  it('day_before_payment without a schedule falls back to the last day of the month', () => {
    expect(recordDateFor('day_before_payment', '2026-09')).toBe('2026-09-30');
  });

  it('whatever recordDateFor gives passes the ledger rule', () => {
    const schedules = [
      undefined,
      { cron: '0 9 1 * *', tz: 'UTC' },
      { cron: '0 9 15 * *', tz: 'UTC' },
      { cron: '0 9 1 * *', tz: 'Pacific/Auckland' },
      { cron: '0 0 1 * *', tz: 'America/Los_Angeles' },
      { cron: '0 9 * * 1', tz: 'Europe/Zurich' },
    ];
    for (const cycleId of ['2026-01', '2026-02', '2026-09', '2026-12', '2028-02']) {
      for (const rule of ['last_day_of_previous_month', 'day_before_payment'] as const) {
        for (const schedule of schedules) {
          const date = recordDateFor(rule, cycleId, schedule);
          expect(recordDateProblem(rule, cycleId, date), `${rule} ${cycleId} ${date}`).toBeNull();
        }
      }
    }
  });
});

describe('record date problems (the ledger rule)', () => {
  it('last_day_of_previous_month wants the last day of the cycle month and nothing else', () => {
    const rule = 'last_day_of_previous_month';
    expect(recordDateProblem(rule, '2026-09', '2026-09-30')).toBeNull();
    expect(recordDateProblem(rule, '2028-02', '2028-02-29')).toBeNull();
    expect(recordDateProblem(rule, '2026-09', '2026-09-29')).toMatch(/last day of 2026-09/);
    expect(recordDateProblem(rule, '2026-09', '2026-08-31')).not.toBeNull();
    expect(recordDateProblem(rule, '2026-09', '2026-10-31')).not.toBeNull();
  });

  it('day_before_payment wants a day inside the cycle month', () => {
    const rule = 'day_before_payment';
    for (const date of ['2026-09-01', '2026-09-14', '2026-09-30']) {
      expect(recordDateProblem(rule, '2026-09', date)).toBeNull();
    }
    for (const date of ['2026-08-31', '2026-10-01', '2025-09-15']) {
      expect(recordDateProblem(rule, '2026-09', date)).toMatch(/inside 2026-09/);
    }
  });
});

describe('schedule', () => {
  it('computes the next run with croner', () => {
    const next = nextRun('0 9 1 * *', 'UTC', new Date('2026-09-15T00:00:00Z'));
    expect(next?.toISOString()).toBe('2026-10-01T09:00:00.000Z');
  });

  it('honors the time zone', () => {
    const next = nextRun('0 9 1 * *', 'America/New_York', new Date('2026-09-15T00:00:00Z'));
    // 09:00 in New York on 1 October (UTC-4) is 13:00 UTC.
    expect(next?.toISOString()).toBe('2026-10-01T13:00:00.000Z');
  });

  it('a run on the 1st pays the month before', () => {
    expect(cycleIdForRun(new Date('2026-10-01T09:00:00Z'), 'UTC')).toBe('2026-09');
    expect(cycleIdForRun(new Date('2027-01-01T09:00:00Z'), 'UTC')).toBe('2026-12');
  });

  it('rejects an invalid cron or time zone with a message that says what to use', () => {
    expect(() => assertSchedule('not a cron', 'UTC')).toThrow('five fields');
    expect(() => assertSchedule('0 9 1 * *', 'Mars/Base')).toThrow('time zone');
    expect(() => assertSchedule('0 9 1 * *', 'UTC')).not.toThrow();
  });
});
