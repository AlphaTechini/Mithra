import type { PolicyFields } from '@mithra/shared';
import { formatAmount, plural, showAmountText } from '../cycle/format';
import { shortPartyId } from '../parties/names';

export interface PolicyDescription {
  /** Plain-English summary, regenerated from the fields after every edit (A1). */
  summary: string;
  /** "The agent can" lines for the seal step. */
  agentCan: string[];
  /** "The agent cannot" lines for the seal step. */
  agentCannot: string[];
  /** e.g. "Monthly on the 1st at 09:00 UTC". */
  scheduleText: string;
  /** e.g. "Last day of the previous month". */
  recordDateText: string;
}

/** Party display names: a lookup object, or a function. Unknown parties get a short id. */
export type PartyNameSource = Readonly<Record<string, string>> | ((partyId: string) => string);

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function ordinal(n: number): string {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
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

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

/** The numbers of a cron field like `1`, `1,15` or `*`; null when it is not a plain list. */
function plainList(field: string): number[] | null {
  if (!/^\d+(,\d+)*$/.test(field)) return null;
  return field.split(',').map((x) => Number.parseInt(x, 10));
}

/**
 * Plain English for the common schedules ("Monthly on the 1st at 09:00 UTC"); any other cron
 * expression is shown as it is.
 */
export function describeSchedule(cron: string, tz: string): string {
  const fields = cron.trim().split(/\s+/);
  const fallback = `On the schedule "${cron}" (${tz})`;
  if (fields.length !== 5) return fallback;
  const [minute = '', hour = '', dom = '', month = '', dow = ''] = fields;
  const minutes = plainList(minute);
  const hours = plainList(hour);
  if (!minutes || !hours || minutes.length !== 1 || hours.length !== 1) return fallback;
  const time = `${String(hours[0]).padStart(2, '0')}:${String(minutes[0]).padStart(2, '0')} ${tz}`;
  const domList = plainList(dom);
  const dowList = plainList(dow);
  const monthList = plainList(month);
  if (dom === '*' && month === '*' && dow === '*') return `Daily at ${time}`;
  if (dom === '*' && month === '*' && dowList) {
    return `Weekly on ${joinList(dowList.map((d) => WEEKDAYS[d % 7] ?? String(d)))} at ${time}`;
  }
  if (dow === '*' && dom === 'L' && month === '*') return `Monthly on the last day at ${time}`;
  if (dow === '*' && domList) {
    const days = joinList(domList.map(ordinal));
    if (month === '*') return `Monthly on the ${days} at ${time}`;
    if (monthList?.join(',') === '1,4,7,10') return `Quarterly on the ${days} at ${time}`;
    if (monthList) {
      const names = monthList.map((m) => MONTH_SHORT[m - 1] ?? String(m));
      return `On the ${days} of ${joinList(names)} at ${time}`;
    }
  }
  return fallback;
}

/** `last_day_of_previous_month` -> "Last day of the previous month". */
export function describeRecordDateRule(rule: string): string {
  switch (rule) {
    case 'last_day_of_previous_month':
      return 'Last day of the previous month';
    case 'day_before_payment':
      return 'The day before payment';
    default:
      return rule;
  }
}

function nameFn(names: PartyNameSource): (partyId: string) => string {
  if (typeof names === 'function') return names;
  return (partyId) => names[partyId] ?? shortPartyId(partyId);
}

/**
 * Describes a policy deterministically from its fields (A1: the summary is regenerated from the
 * fields after every edit, so what the treasurer reads is what they seal). No language model.
 */
export function describePolicy(
  fields: PolicyFields,
  names: PartyNameSource = {},
  assetSymbol = 'CC',
): PolicyDescription {
  const nameOf = nameFn(names);
  const scheduleText = describeSchedule(fields.scheduleCron, fields.scheduleTimezone);
  const recordDateText = describeRecordDateRule(fields.recordDateRule);
  const cap = formatAmount(fields.cap, assetSymbol);
  const approvals = `${fields.approvalThreshold} of ${fields.approvers.length}`;
  const approverNames = fields.approvers.map(nameOf).join(', ');
  const window = plural(fields.unitChangeWindowDays, 'day');

  const summary = [
    `Schedule: ${scheduleText}.`,
    `Record date: ${recordDateText.charAt(0).toLowerCase()}${recordDateText.slice(1)}.`,
    fields.fixedAmount === null
      ? 'The total is set each cycle by the treasurer.'
      : `The total is fixed at ${formatAmount(fields.fixedAmount, assetSymbol)} per cycle.`,
    `Pays automatically when the total is at most ${cap} and every check passes, after a short countdown with a Hold button.`,
    `Otherwise it needs ${approvals} approvals (${approverNames}).`,
    `Flags a total more than ${showAmountText(fields.deviationPct)}% away from the ${fields.trailingCycles}-cycle average, and a holder whose units changed by more than ${showAmountText(fields.unitChangePct)}% in the ${window} before the record date.`,
    `Keeps a fee buffer of ${formatAmount(fields.feeBuffer, assetSymbol)} in the treasury before paying.`,
  ].join(' ');

  const agentCan = [
    'Prepare a distribution on the schedule or whenever you ask for one',
    'Take the record-date snapshot and run every check with the actual values',
    'Write a plain-English memo explaining anything unusual',
    `Pay holders automatically when the total is at most ${cap} and every check passes, after a countdown you can stop with Hold`,
    `Ask your approvers (${approvals}) when the total is above the cap or a check flags it`,
    'Explain flags and answer questions about past cycles',
  ];
  const agentCannot = [
    `Move more than ${cap} without ${approvals} approvals`,
    'Sign or change the Mandate',
    'Approve a proposal',
    'Grant audit access',
    'Compute payout amounts (code does; the agent only explains them)',
    'Clear a deterministic flag',
  ];
  return { summary, agentCan, agentCannot, scheduleText, recordDateText };
}
