import type { PolicyFields } from '@mithra/shared';
import { describe, expect, it } from 'vitest';
import { describePolicy, describeSchedule } from './describe';
import { assertPolicyValid, fieldsFromTerms, policyProblems, termsFromFields } from './fields';

const fields: PolicyFields = {
  cap: '5000',
  approvers: ['ap1::1220aa', 'ap2::1220aa', 'ap3::1220aa'],
  approvalThreshold: 2,
  scheduleCron: '0 9 1 * *',
  scheduleTimezone: 'UTC',
  recordDateRule: 'last_day_of_previous_month',
  fixedAmount: null,
  deviationPct: '50',
  trailingCycles: 3,
  unitChangePct: '100',
  unitChangeWindowDays: 3,
  feeBuffer: '1',
};
const names = {
  'ap1::1220aa': 'Approver 1',
  'ap2::1220aa': 'Approver 2',
  'ap3::1220aa': 'Approver 3',
};

describe('describePolicy', () => {
  it('describes the example policy of userflow.md section 4 in plain English', () => {
    const d = describePolicy(fields, names);
    expect(d.scheduleText).toBe('Monthly on the 1st at 09:00 UTC');
    expect(d.recordDateText).toBe('Last day of the previous month');
    expect(d.summary).toBe(
      'Schedule: Monthly on the 1st at 09:00 UTC. Record date: last day of the previous month. The total is set each cycle by the treasurer. Pays automatically when the total is at most 5,000 CC and every check passes, after a short countdown with a Hold button. Otherwise it needs 2 of 3 approvals (Approver 1, Approver 2, Approver 3). Flags a total more than 50% away from the 3-cycle average, and a holder whose units changed by more than 100% in the 3 days before the record date. Keeps a fee buffer of 1 CC in the treasury before paying.',
    );
  });

  it('is deterministic and regenerated from the fields after an edit (A1)', () => {
    const one = describePolicy(fields, names);
    expect(describePolicy(fields, names)).toEqual(one);
    const edited = describePolicy({ ...fields, cap: '3000', approvalThreshold: 3 }, names);
    expect(edited.summary).toContain('at most 3,000 CC');
    expect(edited.summary).toContain('needs 3 of 3 approvals');
    expect(edited.summary).not.toBe(one.summary);
  });

  it('mentions a fixed amount only when there is one', () => {
    expect(describePolicy({ ...fields, fixedAmount: '1200' }, names).summary).toContain(
      'The total is fixed at 1,200 CC per cycle.',
    );
  });

  it('always lists what the agent cannot do', () => {
    for (const f of [
      fields,
      { ...fields, cap: '0', approvalThreshold: 1, approvers: ['ap1::1220aa'] },
    ]) {
      const cannot = describePolicy(f, names).agentCannot.join(' | ');
      expect(cannot).toMatch(/Move more than .* without \d+ of \d+ approvals/);
      expect(cannot).toContain('Sign or change the Mandate');
      expect(cannot).toContain('Approve a proposal');
      expect(cannot).toContain('Grant audit access');
      expect(cannot).toContain('Compute payout amounts (code does');
      expect(cannot).toContain('Clear a deterministic flag');
    }
  });

  it('says what the agent can do, with the cap and the threshold', () => {
    const can = describePolicy(fields, names).agentCan.join(' | ');
    expect(can).toContain('at most 5,000 CC');
    expect(can).toContain('2 of 3');
    expect(can).toContain('Hold');
  });

  it('uses the asset symbol it is given and falls back to short ids for unknown parties', () => {
    const d = describePolicy({ ...fields, cap: '10' }, {}, 'USDC');
    expect(d.summary).toContain('10 USDC');
    expect(d.summary).toContain('ap1::1220aa');
  });
});

describe('describeSchedule', () => {
  it.each([
    ['0 9 1 * *', 'UTC', 'Monthly on the 1st at 09:00 UTC'],
    ['30 8 15 * *', 'UTC', 'Monthly on the 15th at 08:30 UTC'],
    ['0 9 1,15 * *', 'UTC', 'Monthly on the 1st and 15th at 09:00 UTC'],
    ['0 9 * * 1', 'UTC', 'Weekly on Monday at 09:00 UTC'],
    ['0 9 * * *', 'UTC', 'Daily at 09:00 UTC'],
    ['0 9 1 1,4,7,10 *', 'UTC', 'Quarterly on the 1st at 09:00 UTC'],
    ['0 9 22 * *', 'Europe/Zurich', 'Monthly on the 22nd at 09:00 Europe/Zurich'],
    ['*/5 * * * *', 'UTC', 'On the schedule "*/5 * * * *" (UTC)'],
  ])('%s in %s', (cron, tz, text) => {
    expect(describeSchedule(cron, tz)).toBe(text);
  });
});

describe('policy validation', () => {
  it('accepts the example policy', () => {
    expect(policyProblems(fields, 'agent::1220aa')).toEqual([]);
    expect(() => assertPolicyValid(fields, 'agent::1220aa')).not.toThrow();
  });

  it('rejects duplicate approvers, a threshold above the approvers and the agent as approver', () => {
    const problems = policyProblems(
      {
        ...fields,
        approvers: ['ap1::1220aa', 'ap1::1220aa', 'agent::1220aa'],
        approvalThreshold: 5,
      },
      'agent::1220aa',
    );
    expect(problems.join(' ')).toContain('Each approver can be listed once');
    expect(problems.join(' ')).toContain('The threshold is 5 but there are 2 approvers');
    expect(problems.join(' ')).toContain('The agent cannot be an approver');
  });

  it('rejects negative amounts, a zero fixed amount and an invalid schedule', () => {
    const problems = policyProblems(
      { ...fields, cap: '-1', fixedAmount: '0', feeBuffer: '-2', scheduleCron: 'nope' },
      'agent::1220aa',
    );
    const text = problems.join(' ');
    expect(text).toContain('cap cannot be negative');
    expect(text).toContain('fixed amount must be more than zero');
    expect(text).toContain('fee buffer cannot be negative');
    expect(text).toContain('not a valid schedule');
  });

  it('throws a 422 invalid_policy that lists the problems', () => {
    expect(() => assertPolicyValid({ ...fields, approvalThreshold: 9 }, 'agent::1220aa')).toThrow(
      expect.objectContaining({ status: 422, code: 'invalid_policy' }) as Error,
    );
  });

  it('round-trips terms and fields', () => {
    const asset = { admin: 'dso::1220aa', id: 'Amulet' };
    const terms = termsFromFields(fields, asset);
    expect(terms.asset).toEqual(asset);
    expect(fieldsFromTerms(terms)).toEqual(fields);
  });
});
