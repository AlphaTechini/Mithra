import type { CycleDetail, CycleStatus } from '@mithra/shared';
import { describe, expect, it } from 'vitest';
import { createFakeServices, fakeMandate, fakeNames, FAKE_PARTIES } from '../fakes';
import {
  ALL_TOOLS,
  MALFORMED_REQUEST,
  jsonSchemaOf,
  toolsForRoles,
  type ToolContext,
} from './index';
import { amountsWritten } from './createCycle';
import { sumPayments } from './queryHistory';

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    partyId: FAKE_PARTIES.treasurer.partyId,
    roles: ['treasurer'],
    userText: 'Distribute 1,200 CC for September.',
    services: createFakeServices(),
    names: fakeNames,
    fingerprints: [{ label: 'agent.request', sha256: 'aa' }],
    expiry: undefined,
    scope: undefined,
    proposalWaitMs: 200,
    pollMs: 5,
    now: () => new Date('2026-10-01T09:00:00Z'),
    ...overrides,
  };
}

function tool(name: string) {
  const found = ALL_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

describe('the tool registry (A7: no signing, approving, granting or paying)', () => {
  it('has exactly the specified tools', () => {
    expect(ALL_TOOLS.map((t) => t.name).sort()).toEqual(
      [
        'close_expired_grants',
        'create_cycle',
        'draft_audit_scope',
        'draft_policy',
        'explain_proposal',
        'get_balance',
        'invite_holder',
        'issue_units',
        'list_holders',
        'propose_mandate_change',
        'query_history',
        'run_cycle_now',
      ].sort(),
    );
  });

  it('has no tool whose name suggests approving, signing, granting or executing', () => {
    const forbidden =
      /approve|reject|sign|seal|grant_|_grant\b|execute|pay_|_pay\b|transfer|revoke|deny/i;
    for (const t of ALL_TOOLS) {
      expect(t.name, t.name).not.toMatch(forbidden);
    }
  });

  it('describes every tool without offering a power it must not have', () => {
    // A sentence that mentions approving, signing, sealing, granting, executing or paying must
    // either deny it to the tool (NOT, never, cannot, only a draft) or give it to a person.
    const risky =
      /\b(?:approv(?:e|es|ed|ing)|sign\w*|seals?|grant\w*|execut\w*|pay|pays|paid|transfer\w*)\b/i;
    const safe = /\b(?:NOT|never|cannot|only|treasurer|approvers?|nothing)\b/;
    for (const t of ALL_TOOLS) {
      for (const sentence of t.description.split(/(?<=\.)\s+/)) {
        if (risky.test(sentence)) expect(sentence, `${t.name}: ${sentence}`).toMatch(safe);
      }
      expect(t.description.length, t.name).toBeGreaterThan(40);
    }
    // The tools that touch money or authority say what they will not do.
    for (const name of [
      'create_cycle',
      'draft_policy',
      'propose_mandate_change',
      'draft_audit_scope',
    ]) {
      expect(tool(name).description, name).toMatch(/NOT|never/);
    }
  });

  it('offers writes to the treasurer only; approvers get the read-only four', () => {
    expect(
      toolsForRoles(['approver'])
        .map((t) => t.name)
        .sort(),
    ).toEqual(['explain_proposal', 'get_balance', 'list_holders', 'query_history']);
    expect(toolsForRoles(['treasurer'])).toHaveLength(ALL_TOOLS.length);
    expect(toolsForRoles(['holder'])).toEqual([]);
    expect(toolsForRoles(['auditor'])).toEqual([]);
  });

  it('converts every parameter schema to JSON Schema that is closed, in both modes', () => {
    for (const t of ALL_TOOLS) {
      for (const strict of [false, true]) {
        const schema = jsonSchemaOf(t, strict);
        expect(schema['type'], t.name).toBe('object');
        expect(schema['additionalProperties'], t.name).toBe(false);
        expect(schema['$schema'], t.name).toBeUndefined();
        if (strict) {
          const props = Object.keys(schema['properties'] as object).sort();
          expect([...(schema['required'] as string[])].sort(), t.name).toEqual(props);
        }
      }
    }
  });
});

describe('argument validation: invalid arguments never run the tool', () => {
  const malformedCases: [string, string][] = [
    ['create_cycle', '{"total":"abc"}'],
    ['create_cycle', '{}'],
    ['create_cycle', '{"total":"-5"}'],
    ['create_cycle', '{"total":"0"}'],
    ['create_cycle', '{"total":"1200","period":"September"}'],
    ['create_cycle', '{"total":"1200","recordDate":"30/09/2026"}'],
    ['create_cycle', 'not json'],
    ['create_cycle', '[1200]'],
    ['run_cycle_now', '{"total":"5"}'],
    ['explain_proposal', '{"cycle":""}'],
    ['query_history', '{"from":"July"}'],
    ['query_history', '{"holderName":""}'],
    ['issue_units', '{"holderName":"Holder B","units":0}'],
    ['issue_units', '{"holderName":"Holder B","units":1.5}'],
    ['issue_units', '{"units":5}'],
    ['invite_holder', '{}'],
    ['draft_audit_scope', '{"question":""}'],
    ['draft_policy', '{"cap":"5000"}'],
    ['draft_policy', '{"cap":"5000","approvalThreshold":2,"scheduleCron":"not a cron"}'],
    [
      'draft_policy',
      '{"cap":"5000","approvalThreshold":2,"scheduleCron":"0 9 1 * *","scheduleTimezone":"Mars/Base"}',
    ],
    ['draft_policy', '{"cap":"-1","approvalThreshold":2,"scheduleCron":"0 9 1 * *"}'],
    ['propose_mandate_change', '{"cap":"lots"}'],
    ['close_expired_grants', '{"force":true}'],
    ['get_balance', '{"asset":"CC"}'],
    ['list_holders', '{"x":1}'],
  ];
  it.each(malformedCases)('%s with %s is refused and nothing is called', async (name, args) => {
    const ctx = context();
    const run = await tool(name).execute(args, ctx);
    expect(run.card.status).toBe('failed');
    expect(run.card.title).toBe(MALFORMED_REQUEST);
    expect(run.card.title).toBe("The agent's request was malformed, so nothing was done.");
    expect((ctx.services as ReturnType<typeof createFakeServices>).calls).toEqual([]);
  });

  it('create_cycle has no per-holder amount parameter and rejects extra fields (A3)', async () => {
    const ctx = context();
    const schema = jsonSchemaOf(tool('create_cycle'), false);
    expect(Object.keys(schema['properties'] as object).sort()).toEqual([
      'period',
      'recordDate',
      'total',
    ]);
    const run = await tool('create_cycle').execute(
      JSON.stringify({
        total: '1200',
        payouts: [{ holder: 'Holder A', amount: '1199' }],
        amounts: { 'Holder A': '1' },
      }),
      ctx,
    );
    expect(run.card.status).toBe('failed');
    expect((ctx.services as ReturnType<typeof createFakeServices>).runs).toEqual([]);
  });

  it('treats null as "not given" for optional fields, as strict-mode models send them', async () => {
    const ctx = context();
    const run = await tool('create_cycle').execute(
      '{"total":"1200","period":null,"recordDate":null}',
      ctx,
    );
    expect(run.card.status).toBe('done');
    const services = ctx.services as ReturnType<typeof createFakeServices>;
    expect(services.runs[0]).toMatchObject({ total: '1200' });
    expect(services.runs[0]).not.toHaveProperty('cycleId');
  });
});

describe('create_cycle', () => {
  it('passes the requested total, the prompt and the fingerprints; the card names the proposal', async () => {
    const ctx = context();
    const run = await tool('create_cycle').execute('{"total":"1200","period":"2026-09"}', ctx);
    const services = ctx.services as ReturnType<typeof createFakeServices>;
    expect(services.runs).toHaveLength(1);
    expect(services.runs[0]).toMatchObject({
      trigger: 'prompt',
      cycleId: '2026-09',
      total: '1200',
      promptText: 'Distribute 1,200 CC for September.',
      modelFingerprints: [{ label: 'agent.request', sha256: 'aa' }],
      actorParty: FAKE_PARTIES.treasurer.partyId,
    });
    expect(services.runs[0]?.triggerDetail).toContain('Treasurer');
    expect(run.card).toMatchObject({
      tool: 'create_cycle',
      title: 'Created proposal for September 2026, 4 payees, 1,200 CC',
      status: 'done',
      link: '/app/cycles/2026-09',
    });
    // Per-holder amounts are not parameters of the call.
    expect(Object.keys(services.runs[0] ?? {})).not.toContain('payouts');
  });

  it('refuses a total that is not an amount the user wrote, and starts nothing', async () => {
    const ctx = context({ userText: 'Distribute 1,200 CC for September.' });
    const run = await tool('create_cycle').execute('{"total":"9999"}', ctx);
    expect(run.card.status).toBe('failed');
    expect(run.card.summary).toContain('not an amount you wrote');
    expect((ctx.services as ReturnType<typeof createFakeServices>).runs).toEqual([]);
  });

  it('accepts amounts written as 1,200 / 1200.50 / 5k / 2 million', () => {
    expect(amountsWritten('Pay 1,200 CC').map(String)).toContain('1200');
    expect(amountsWritten('Pay 1200.50 CC').map(String)).toContain('1200.5');
    expect(amountsWritten('Pay 5k now').map(String)).toContain('5000');
    expect(amountsWritten('send 2 million').map(String)).toContain('2000000');
    expect(amountsWritten('pay 50,000 CC now').map(String)).toContain('50000');
  });

  it('does not count years, dates, cycle ids, quarters, counts, ordinals or percentages as amounts', () => {
    for (const text of [
      'Distribute for September 2026',
      'Run Q3',
      'Run Q3 2026',
      'Needs 2 of 3 approvals',
      'Pay for 2026-09',
      'Record date 2026-09-30',
      'Pay on the 3rd',
      'Pay on 30 September',
      'Pay on September 30, 2026',
      'Flag at 50% or 12.5 percent',
    ]) {
      expect(amountsWritten(text).map(String), text).toEqual([]);
    }
  });

  it('keeps the amount next to a date or period', () => {
    expect(amountsWritten('Distribute 300 CC for August 2026.').map(String)).toEqual(['300']);
    expect(amountsWritten('1,200 CC for September').map(String)).toEqual(['1200']);
    expect(amountsWritten('Pay 1.2k for 2026-09').map(String)).toEqual(['1200']);
    expect(amountsWritten('Pay 300 CC in Q3, 2 of 3 approving').map(String)).toEqual(['300']);
    expect(amountsWritten('Pay 2026 CC for September 2026').map(String)).toEqual(['2026']);
  });

  it('refuses a total of 2026 for "Distribute for September 2026", and starts nothing', async () => {
    const ctx = context({ userText: 'Distribute for September 2026' });
    const run = await tool('create_cycle').execute('{"total":"2026"}', ctx);
    expect(run.card.status).toBe('failed');
    expect(run.card.summary).toContain('not an amount you wrote');
    expect((ctx.services as ReturnType<typeof createFakeServices>).runs).toEqual([]);
    const q3 = context({ userText: 'Run Q3' });
    expect((await tool('create_cycle').execute('{"total":"3"}', q3)).card.status).toBe('failed');
  });

  it('is only for the treasurer', () => {
    expect(tool('create_cycle').roles).toEqual(['treasurer']);
  });

  it('shows a still-running cycle without claiming it is ready', async () => {
    const services = createFakeServices();
    services.state.proposalDelayPolls = 1000;
    const run = await tool('create_cycle').execute(
      '{"total":"1200"}',
      context({ services, proposalWaitMs: 50 }),
    );
    expect(run.card.status).toBe('done');
    expect(run.card.title).toContain('Started the cycle');
    expect(run.result).toMatchObject({ proposalReady: false });
  });

  it('waits for a proposal that is not ready on the first poll', async () => {
    const services = createFakeServices();
    services.state.proposalDelayPolls = 3;
    const run = await tool('create_cycle').execute('{"total":"1200"}', context({ services }));
    expect(run.card.title).toContain('Created proposal');
  });

  it('reports a service error as a failed card with a message, not a crash', async () => {
    const services = createFakeServices();
    services.cycles.run = () => Promise.reject(new Error('internal detail'));
    const run = await tool('create_cycle').execute('{"total":"1200"}', context({ services }));
    expect(run.card.status).toBe('failed');
    expect(run.card.summary).not.toContain('internal detail');
  });
});

describe('create_cycle and the cap (A6)', () => {
  it('gives the code-written sentence when the total is above the cap', async () => {
    const ctx = context({ userText: 'pay 50,000 CC now' });
    const run = await tool('create_cycle').execute('{"total":"50000"}', ctx);
    expect(run.card.status).toBe('needs-you');
    expect(run.card.summary).toContain('Needs 2 of 3 approvals');
    expect(run.replyNotes).toEqual([
      "50,000 CC is above your auto-pay cap of 5,000 CC. I've prepared this as a proposal that needs 2 of 3 approvals.",
    ]);
  });

  it('adds no sentence when the proposal is within the Mandate', async () => {
    const run = await tool('create_cycle').execute('{"total":"1200"}', context());
    expect(run.replyNotes ?? []).toEqual([]);
  });
});

describe('run_cycle_now', () => {
  it('runs with the manual trigger and no amount', async () => {
    const ctx = context();
    const run = await tool('run_cycle_now').execute('{}', ctx);
    const services = ctx.services as ReturnType<typeof createFakeServices>;
    expect(services.runs[0]).toMatchObject({
      trigger: 'manual',
      actorParty: FAKE_PARTIES.treasurer.partyId,
    });
    expect(services.runs[0]).not.toHaveProperty('total');
    expect(run.card.tool).toBe('run_cycle_now');
  });
});

/** A fake cycle that already exists in `status`, as the engine would show it. */
async function existingCycle(
  status: CycleStatus,
  patch: Partial<CycleDetail> = {},
  total = '300',
): Promise<ReturnType<typeof createFakeServices>> {
  const services = createFakeServices();
  await services.cycles.run({
    trigger: 'prompt',
    triggerDetail: 'earlier',
    cycleId: '2026-09',
    total,
    actorParty: 'p',
  });
  const detail = services.cycles.store.get('2026-09')!;
  services.cycles.store.set('2026-09', {
    ...detail,
    ...patch,
    summary: { ...detail.summary, status },
  });
  services.runs.length = 0;
  return services;
}

const EXECUTED = {
  kind: 'executed',
  actor: FAKE_PARTIES.treasurer,
  reason: null,
  at: '2026-10-01T09:00:00.000Z',
} as const;

describe('create_cycle and run_cycle_now on a cycle that already exists', () => {
  const settled = (services: ReturnType<typeof createFakeServices>, text: string) =>
    context({ services, userText: text });

  it('September already paid: says so with the date and creates nothing', async () => {
    const services = await existingCycle('paid-automatically', { outcome: EXECUTED });
    const ctx = settled(services, 'Distribute 300 CC for September.');
    const run = await tool('create_cycle').execute('{"total":"300","period":"2026-09"}', ctx);
    expect(run.card.status).toBe('done');
    expect(run.card.title).toBe('September 2026 was already paid');
    expect(run.card.summary).toBe(
      'September 2026 was already paid automatically on 1 October 2026. Nothing new was created.',
    );
    expect(run.card.summary).not.toContain('hold countdown');
    expect(run.replyNotes).toEqual([run.card.summary]);
    expect(run.result).toMatchObject({ ok: true, existedBefore: true });
    expect((run.result as { note: string }).note).toContain('already paid');
    // The fake keeps the paid cycle: nothing new was created.
    expect(services.cycles.store.get('2026-09')?.summary.status).toBe('paid-automatically');
  });

  it('run_cycle_now on a paid cycle words it the same way, and a cycle paid after approval says so', async () => {
    const services = await existingCycle('paid-after-approval', { outcome: EXECUTED });
    const run = await tool('run_cycle_now').execute('{}', settled(services, 'Run the cycle'));
    expect(run.card.tool).toBe('run_cycle_now');
    expect(run.card.summary).toBe(
      'September 2026 was already paid after approval on 1 October 2026. Nothing new was created.',
    );
  });

  it('a cycle paid whose payments wait for a holder says so', async () => {
    const services = await existingCycle('awaiting-acceptance', { outcome: EXECUTED });
    const run = await tool('create_cycle').execute(
      '{"total":"300","period":"2026-09"}',
      settled(services, 'Distribute 300 CC for September.'),
    );
    expect(run.card.summary).toContain('already paid on 1 October 2026');
    expect(run.card.summary).toContain('still has to accept');
  });

  it('awaiting approval: says the proposal already waits, and adds no cap sentence', async () => {
    const services = await existingCycle('awaiting-approval', {}, '9000');
    const run = await tool('create_cycle').execute(
      '{"total":"9000","period":"2026-09"}',
      settled(services, 'Distribute 9000 CC for September.'),
    );
    expect(run.card.status).toBe('needs-you');
    expect(run.card.title).toBe('September 2026 already has a proposal waiting for approval');
    expect(run.card.summary).toContain('Needs 2 of 3 approvals, 0 so far.');
    expect(run.card.summary).toContain('Nothing new was created.');
    expect(run.replyNotes).toEqual([run.card.summary]);
  });

  it('held: says it is on hold', async () => {
    const services = await existingCycle('held');
    const run = await tool('create_cycle').execute(
      '{"total":"300","period":"2026-09"}',
      settled(services, 'Distribute 300 CC for September.'),
    );
    expect(run.card.status).toBe('needs-you');
    expect(run.card.summary).toContain('is on hold');
    expect(run.card.summary).toContain('Nothing new was created.');
  });

  it('needs funds: gives the shortfall', async () => {
    const services = await existingCycle('needs-funds', {
      fundsShortfall: { balance: '100.0000000000', required: '301.0000000000' },
    });
    const run = await tool('run_cycle_now').execute('{}', settled(services, 'Run the cycle'));
    expect(run.card.status).toBe('needs-you');
    expect(run.card.summary).toContain('100 CC available, 301 CC needed');
    expect(run.card.summary).toContain('Add funds');
  });

  it('failed: shows the error and starts a new attempt', async () => {
    const services = await existingCycle('failed', { error: 'The ledger was unreachable' });
    const run = await tool('create_cycle').execute(
      '{"total":"300","period":"2026-09"}',
      settled(services, 'Distribute 300 CC for September.'),
    );
    // A failed cycle is started again by the engine; the fake does the same, so this is a new cycle.
    expect(services.runs).toHaveLength(1);
    expect(run.card.title).toContain('Created proposal for September 2026');
  });

  it('failed after its proposal: the card carries the error', async () => {
    const services = createFakeServices();
    services.cycles.run = (input) => {
      services.runs.push(input);
      return Promise.resolve({ cycleId: '2026-09' });
    };
    const base = createFakeServices();
    await base.cycles.run({ trigger: 'prompt', triggerDetail: 'x', total: '300', actorParty: 'p' });
    const detail = base.cycles.store.get('2026-09')!;
    services.cycles.store.set('2026-09', {
      ...detail,
      error: 'Paying Holder C failed: no preapproval',
      summary: { ...detail.summary, status: 'failed' },
    });
    const run = await tool('create_cycle').execute(
      '{"total":"300","period":"2026-09"}',
      settled(services, 'Distribute 300 CC for September.'),
    );
    expect(run.card.status).toBe('failed');
    expect(run.card.summary).toBe('Paying Holder C failed: no preapproval');
    expect(run.result).toMatchObject({ ok: false });
    expect(run.replyNotes).toEqual(['Paying Holder C failed: no preapproval']);
  });

  it('a new within-mandate cycle keeps the countdown wording', async () => {
    const run = await tool('create_cycle').execute('{"total":"1200"}', context());
    expect(run.card.summary).toBe(
      'Within your mandate. It runs automatically after the hold countdown.',
    );
    expect(run.result).toMatchObject({ existedBefore: false });
  });
});

describe('explain_proposal', () => {
  it('explains the latest cycle with checks, verdict and memo, read-only', async () => {
    const services = createFakeServices();
    await services.cycles.run({
      trigger: 'prompt',
      triggerDetail: 'x',
      total: '9000',
      actorParty: 'p',
    });
    services.calls.length = 0;
    const run = await tool('explain_proposal').execute(
      '{}',
      context({ services, roles: ['approver'] }),
    );
    expect(run.card.title).toBe('Explained September 2026');
    expect(run.result).toMatchObject({
      ok: true,
      proposal: { verdict: 'needs-approval', memo: 'Fake memo.' },
    });
    expect(services.writes()).toEqual([]);
  });

  it('says so when there is no such cycle', async () => {
    const run = await tool('explain_proposal').execute('{"cycle":"2031-01"}', context());
    expect(run.card.status).toBe('failed');
  });
});

describe('query_history: sums are computed in code', () => {
  it('sums rows exactly with decimal arithmetic, in total and per holder', () => {
    const rows = [
      {
        holder: FAKE_PARTIES.holderB,
        cycleLabel: 'July 2026',
        amount: '120.1000000000',
        at: '2026-07-01T09:00:00Z',
        status: 'paid',
      },
      {
        holder: FAKE_PARTIES.holderB,
        cycleLabel: 'August 2026',
        amount: '0.2000000000',
        at: '2026-08-01T09:00:00Z',
        status: 'paid',
      },
      {
        holder: FAKE_PARTIES.holderA,
        cycleLabel: 'July 2026',
        amount: '0.1000000000',
        at: '2026-07-01T09:00:00Z',
        status: 'awaiting-acceptance',
      },
    ];
    const sums = sumPayments(rows);
    expect(sums.total).toBe('120.4000000000');
    expect(sums.byHolder).toEqual([
      { holder: 'Holder A', total: '0.1000000000', payments: 1 },
      { holder: 'Holder B', total: '120.3000000000', payments: 2 },
    ]);
    expect(sums.byStatus.find((s) => s.status === 'paid')?.total).toBe('120.3000000000');
  });

  it('resolves the holder by name in code and filters by date', async () => {
    const services = createFakeServices();
    services.state.payments = [
      {
        holder: FAKE_PARTIES.holderB,
        cycleLabel: 'July 2026',
        amount: '100',
        at: '2026-07-01T09:00:00Z',
        status: 'paid',
      },
      {
        holder: FAKE_PARTIES.holderB,
        cycleLabel: 'Oct 2026',
        amount: '999',
        at: '2026-10-01T09:00:00Z',
        status: 'paid',
      },
      {
        holder: FAKE_PARTIES.holderA,
        cycleLabel: 'July 2026',
        amount: '7',
        at: '2026-07-01T09:00:00Z',
        status: 'paid',
      },
    ];
    const run = await tool('query_history').execute(
      '{"holderName":"holder b","from":"2026-07-01","to":"2026-09-30"}',
      context({ services, roles: ['approver'] }),
    );
    expect(services.calls.find((c) => c.method === 'history.payments')?.args).toEqual({
      holder: FAKE_PARTIES.holderB.partyId,
      from: '2026-07-01',
      to: '2026-09-30',
    });
    expect(run.result).toMatchObject({ rowCount: 1, sums: { totalReadable: '100 CC' } });
    expect(run.card.summary).toBe('1 payment, 100 CC in total');
  });

  it('fails clearly for a name nobody has', async () => {
    const run = await tool('query_history').execute('{"holderName":"Zed"}', context());
    expect(run.card.status).toBe('failed');
    expect(run.card.summary).toContain('Zed');
  });
});

describe('policy tools', () => {
  const approverNames = ['Approver 1', 'Approver 2', 'Approver 3'];

  it('draft_policy saves an agent draft and never seals', async () => {
    const ctx = context();
    const run = await tool('draft_policy').execute(
      JSON.stringify({
        cap: '5000',
        approvalThreshold: 2,
        approverNames,
        scheduleCron: '0 9 1 * *',
      }),
      ctx,
    );
    const services = ctx.services as ReturnType<typeof createFakeServices>;
    expect(run.card).toMatchObject({
      title: 'Drafted a policy for you to review and seal',
      status: 'needs-you',
      link: '/setup/policy',
    });
    expect(services.writes().map((c) => c.method)).toEqual(['policy.saveDraft']);
    expect(services.writes()[0]?.args).toMatchObject({
      source: 'agent',
      party: FAKE_PARTIES.treasurer.partyId,
    });
  });

  it('draft_policy fails when an approver name is unknown and saves nothing', async () => {
    const ctx = context();
    const run = await tool('draft_policy').execute(
      JSON.stringify({
        cap: '5000',
        approvalThreshold: 2,
        approverNames: ['Approver 1', 'Nobody'],
        scheduleCron: '0 9 1 * *',
      }),
      ctx,
    );
    expect(run.card.status).toBe('failed');
    expect(run.card.summary).toContain('"Nobody"');
    expect(run.card.summary).toContain('policy form');
    expect((ctx.services as ReturnType<typeof createFakeServices>).writes()).toEqual([]);
  });

  it('draft_policy fails when the threshold exceeds the approvers', async () => {
    const run = await tool('draft_policy').execute(
      JSON.stringify({
        cap: '5000',
        approvalThreshold: 4,
        approverNames,
        scheduleCron: '0 9 1 * *',
      }),
      context(),
    );
    expect(run.card.status).toBe('failed');
    expect(run.card.summary).toContain('needs at least 4 approvers');
  });

  it('draft_policy uses the Mandate approvers when no names were given', async () => {
    const ctx = context();
    const run = await tool('draft_policy').execute(
      JSON.stringify({ cap: '5000', approvalThreshold: 2, scheduleCron: '0 9 1 * *' }),
      ctx,
    );
    expect(run.card.status).toBe('needs-you');
    const saved = (ctx.services as ReturnType<typeof createFakeServices>).writes()[0]?.args as {
      fields: { approvers: string[] };
    };
    expect(saved.fields.approvers).toHaveLength(3);
  });

  it('propose_mandate_change changes only what is named and says to re-seal', async () => {
    const ctx = context();
    const run = await tool('propose_mandate_change').execute('{"cap":"3000"}', ctx);
    expect(run.card).toMatchObject({
      title: 'Drafted a Mandate change. Review and re-seal to apply it.',
      status: 'needs-you',
      link: '/app/settings',
    });
    expect(run.card.details).toEqual([{ label: 'Auto-pay cap', value: '5,000 CC to 3,000 CC' }]);
    const saved = (ctx.services as ReturnType<typeof createFakeServices>).writes()[0]?.args as {
      fields: Record<string, unknown>;
    };
    expect(saved.fields).toMatchObject({
      cap: '3000',
      approvalThreshold: 2,
      scheduleCron: '0 9 1 * *',
      trailingCycles: 3,
    });
  });

  it('propose_mandate_change refuses a no-op and a missing Mandate', async () => {
    const same = await tool('propose_mandate_change').execute('{"cap":"5000"}', context());
    expect(same.card.status).toBe('failed');
    const services = createFakeServices();
    services.state.mandate = null;
    const none = await tool('propose_mandate_change').execute(
      '{"cap":"3000"}',
      context({ services }),
    );
    expect(none.card.status).toBe('failed');
    expect(none.card.summary).toContain('no sealed Mandate');
  });
});

describe('propose_mandate_change with ledger decimals', () => {
  function sealedWithLedgerForm(): ReturnType<typeof createFakeServices> {
    const services = createFakeServices();
    const base = fakeMandate('5000.0000000000');
    services.state.mandate = {
      ...base,
      terms: {
        ...base.terms,
        fixedAmount: '1200.0000000000',
        deviationPct: '50.0000000000',
        unitChangePct: '100.0000000000',
        feeBuffer: '1.0000000000',
      },
    };
    return services;
  }

  it('does not call 5000 a change from the sealed 5000.0000000000', async () => {
    const run = await tool('propose_mandate_change').execute(
      '{"cap":"5000","fixedAmount":"1200","deviationPct":"50","unitChangePct":"100","feeBuffer":"1"}',
      context({ services: sealedWithLedgerForm() }),
    );
    expect(run.card.status).toBe('failed');
    expect(run.card.summary).toContain('already matches');
  });

  it('lists only the fields whose value really changes', async () => {
    const run = await tool('propose_mandate_change').execute(
      '{"cap":"5000","feeBuffer":"2","approvalThreshold":3}',
      context({ services: sealedWithLedgerForm() }),
    );
    expect(run.card.details?.map((d) => d.label)).toEqual(['Approval threshold', 'Fee buffer']);
  });
});

describe('holder tools', () => {
  it('issue_units resolves the name in code and passes the party id', async () => {
    const ctx = context();
    const run = await tool('issue_units').execute('{"holderName":"Holder B","units":50}', ctx);
    expect(run.card.title).toBe('Issued 50 units to Holder B');
    expect((ctx.services as ReturnType<typeof createFakeServices>).writes()[0]?.args).toEqual({
      holder: FAKE_PARTIES.holderB.partyId,
      units: 50,
      actorParty: FAKE_PARTIES.treasurer.partyId,
    });
  });

  it('issue_units fails for an unknown or ambiguous name and issues nothing', async () => {
    const ctx = context();
    const unknown = await tool('issue_units').execute('{"holderName":"Zed","units":5}', ctx);
    const ambiguous = await tool('issue_units').execute('{"holderName":"Holder","units":5}', ctx);
    expect(unknown.card.status).toBe('failed');
    expect(ambiguous.card.status).toBe('failed');
    expect((ctx.services as ReturnType<typeof createFakeServices>).writes()).toEqual([]);
  });

  it('invite_holder creates a holder invite and shows the link', async () => {
    const ctx = context();
    const run = await tool('invite_holder').execute('{"displayName":"Nova Capital"}', ctx);
    expect(run.card).toMatchObject({ status: 'done', link: '/invite/INV1' });
    expect((ctx.services as ReturnType<typeof createFakeServices>).writes()[0]?.args).toMatchObject(
      {
        kind: 'holder',
        displayName: 'Nova Capital',
      },
    );
  });

  it('list_holders and get_balance read only', async () => {
    const ctx = context({ roles: ['approver'] });
    const list = await tool('list_holders').execute('{}', ctx);
    const balance = await tool('get_balance').execute('{}', ctx);
    expect(list.card.title).toBe('Listed 4 holders');
    expect(balance.card.title).toBe('Treasury balance: 25,000 CC');
    expect((ctx.services as ReturnType<typeof createFakeServices>).writes()).toEqual([]);
  });

  it('get_balance fails clearly when the balance cannot be read', async () => {
    const services = createFakeServices();
    services.state.balance = null;
    const run = await tool('get_balance').execute('{}', context({ services }));
    expect(run.card.status).toBe('failed');
  });
});

describe('close_expired_grants and draft_audit_scope', () => {
  it('close_expired_grants calls the expiry job', async () => {
    let called = 0;
    const run = await tool('close_expired_grants').execute(
      '{}',
      context({
        expiry: {
          closeExpiredNow: () => {
            called += 1;
            return Promise.resolve({ closed: 2, failed: 0 });
          },
        },
      }),
    );
    expect(called).toBe(1);
    expect(run.card.title).toBe('Closed 2 expired grants');
  });

  it('close_expired_grants fails safe without the job', async () => {
    const run = await tool('close_expired_grants').execute('{}', context());
    expect(run.card.status).toBe('failed');
  });

  it('draft_audit_scope shows the proposed records and grants nothing', async () => {
    const run = await tool('draft_audit_scope').execute(
      '{"question":"Show Q3 distributions"}',
      context({
        scope: {
          draft: () =>
            Promise.resolve({
              items: [{ recordId: 'outcome/2026-09/1', kind: 'outcome', reason: 'What was paid' }],
              excluded: 'Holder identities',
              source: 'ai' as const,
            }),
        },
      }),
    );
    expect(run.card.title).toBe('Drafted an audit scope: 1 record');
    expect(run.card.details).toEqual([{ label: 'outcome/2026-09/1', value: 'What was paid' }]);
  });
});
