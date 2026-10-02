import { describe, expect, it } from 'vitest';
import { describeRecordDate, describeSchedule, formatAmount, ordinalWord } from './format';

describe('describeSchedule', () => {
  it('describes monthly, daily and weekly crons', () => {
    expect(describeSchedule('0 9 1 * *', 'UTC')).toBe('Monthly on the 1st at 09:00 UTC');
    expect(describeSchedule('30 17 22 * *', 'Europe/Zurich')).toBe(
      'Monthly on the 22nd at 17:30 Europe/Zurich',
    );
    expect(describeSchedule('0 0 3 * *', 'UTC')).toBe('Monthly on the 3rd at 00:00 UTC');
    expect(describeSchedule('0 8 11 * *', 'UTC')).toBe('Monthly on the 11th at 08:00 UTC');
    expect(describeSchedule('15 6 * * *', 'UTC')).toBe('Daily at 06:15 UTC');
    expect(describeSchedule('0 9 * * 1', 'UTC')).toBe('Weekly on Monday at 09:00 UTC');
  });

  it('never describes a cron it does not understand', () => {
    expect(describeSchedule('*/5 * * * *', 'UTC')).toBe('Cron "*/5 * * * *" (UTC)');
    expect(describeSchedule('0 9 1 6 *', 'UTC')).toBe('Cron "0 9 1 6 *" (UTC)');
    expect(describeSchedule('0 9 40 * *', 'UTC')).toBe('Cron "0 9 40 * *" (UTC)');
    expect(describeSchedule('nonsense', 'UTC')).toBe('Cron "nonsense" (UTC)');
  });
});

describe('describeRecordDate', () => {
  it('names the known rules and passes unknown ones through', () => {
    expect(describeRecordDate('last_day_of_previous_month')).toBe('Last day of the previous month');
    expect(describeRecordDate('day_before_payment')).toBe('The day before payment');
    expect(describeRecordDate('custom')).toBe('custom');
  });
});

describe('formatAmount', () => {
  it('uses thousands separators and trims trailing zeros', () => {
    expect(formatAmount('10000')).toBe('10,000');
    expect(formatAmount('1200.5000000000')).toBe('1,200.5');
    expect(formatAmount('5000.0000000000')).toBe('5,000');
    expect(formatAmount('0.0000000001')).toBe('0.0000000001');
    expect(formatAmount('1234567.89')).toBe('1,234,567.89');
  });
});

describe('ordinalWord', () => {
  it('names positions', () => {
    expect([1, 2, 3].map(ordinalWord)).toEqual(['first', 'second', 'third']);
  });
});
