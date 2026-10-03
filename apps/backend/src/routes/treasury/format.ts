import Decimal from 'decimal.js';

/** "10000" → "10,000"; "1200.5000000000" → "1,200.5". Thousands separators, no trailing zeros. */
export function formatAmount(amount: string): string {
  const fixed = new Decimal(amount).toFixed();
  const [whole = '0', fraction] = fixed.split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const digits = whole.replace('-', '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${sign}${digits}.${fraction}` : `${sign}${digits}`;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const NUMBER = /^\d+$/;

/**
 * Plain English for the common cron shapes `m h d * *` (monthly), `m h * * *` (daily) and
 * `m h * * dow` (weekly): "Monthly on the 1st at 09:00 UTC". Anything else is shown as the cron
 * text with its time zone, so nothing is ever described wrongly.
 */
export function describeSchedule(cron: string, timezone: string): string {
  const fields = cron.trim().split(/\s+/);
  const raw = `Cron "${cron.trim()}" (${timezone})`;
  if (fields.length !== 5) return raw;
  const [minute = '', hour = '', day = '', month = '', weekday = ''] = fields;
  if (!NUMBER.test(minute) || !NUMBER.test(hour) || month !== '*') return raw;
  const m = Number(minute);
  const h = Number(hour);
  if (m > 59 || h > 23) return raw;
  const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${timezone}`;
  if (NUMBER.test(day) && weekday === '*') {
    const d = Number(day);
    if (d < 1 || d > 31) return raw;
    return `Monthly on the ${ordinal(d)} at ${time}`;
  }
  if (day === '*' && weekday === '*') return `Daily at ${time}`;
  if (day === '*' && NUMBER.test(weekday)) {
    // 0 and 7 are both Sunday in cron; anything else is not a weekday.
    const dow = Number(weekday);
    if (dow > 7) return raw;
    const name = WEEKDAYS[dow % 7];
    return name ? `Weekly on ${name} at ${time}` : raw;
  }
  return raw;
}

/** Plain English for a record date rule. Unknown rules are shown as they are. */
export function describeRecordDate(rule: string): string {
  switch (rule) {
    case 'last_day_of_previous_month':
      return 'Last day of the previous month';
    case 'day_before_payment':
      return 'The day before payment';
    default:
      return rule;
  }
}

/** The weekday-free ordinal word for "wait until a second node is back". */
export function ordinalWord(n: number): string {
  const words = ['first', 'second', 'third', 'fourth', 'fifth'];
  return words[n - 1] ?? ordinal(n);
}
