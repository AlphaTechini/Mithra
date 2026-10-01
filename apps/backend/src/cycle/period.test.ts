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
    const mid = { cron: '0 9 15 * *', tz: 'UTC' };
    expect(recordDateFor('day_before_payment', '2026-09', mid)).toBe('2026-10-14');
  });

  it('day_before_payment without a schedule falls back to the last day of the month', () => {
    expect(recordDateFor('day_before_payment', '2026-09')).toBe('2026-09-30');
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
