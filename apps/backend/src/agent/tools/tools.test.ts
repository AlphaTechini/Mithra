import { describe, expect, it } from 'vitest';
import { createFakeServices, fakeNames, FAKE_PARTIES } from '../fakes';
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
