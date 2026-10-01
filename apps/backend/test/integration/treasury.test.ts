import {
  ActivityResponseSchema,
  HolderPositionSchema,
  HoldersResponseSchema,
  InfrastructureResponseSchema,
  InviteSchema,
  OrgResponseSchema,
  OverviewResponseSchema,
  type HolderPosition,
} from '@mithra/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config/env';
import { createDatabase, runMigrations, type DatabaseHandle } from '../../src/db';
import { txRefs } from '../../src/db/schema';
import { choiceResults } from '../../src/ledger';
import { opaqueId } from '../../src/holders/position';
import { SIGN_IN_WALLET_MESSAGE } from '../../src/routes/treasury';
import {
  daysAgo,
  defaultTerms,
  isoDate,
  requireSandbox,
  resetDatabase,
  submitter,
  testLeg,
} from './helpers';
import {
  buildTreasuryApp,
  createStubCycles,
  createTestAssetAdapter,
  createTestFunding,
  createTreasuryWorld,
  cycleSummary,
  sameDecimal,
  treasuryProposalInput,
  type Switches,
  type TreasuryApp,
  type TreasuryWorld,
} from './treasuryHelpers';

// The database of milestone M4b only; the other implementers use their own.
const DATABASE_URL =
  process.env['DATABASE_URL_TEST_M4B'] ?? 'postgres://mithra:mithra@localhost:5432/mithra_test_m4b';

interface ErrorJson {
  error: { code: string; message: string };
}

describe('treasury, holder and overview routes against a Canton sandbox and PostgreSQL', () => {
  let world: TreasuryWorld;
  let database: DatabaseHandle;
  let t: TreasuryApp;
  let mainnet: TreasuryApp;
  const switches: Switches = {
    failBalance: false,
    acceptContext: 'ok',
    skipPreapproval: false,
    failFunding: false,
  };
  const cycles = createStubCycles();
  let funding: ReturnType<typeof createTestFunding>;
  let cookies: Record<string, { cookie: string }>;

  // Filled in as the tests run.
  const unitIds: Record<string, string> = {};
  const payoutAmounts: Record<string, string> = {};
  /** Payment contract ids by holder party, and the ids the API shows for them. */
  const paymentCids: Record<string, string> = {};
  const paymentIds: Record<string, string> = {};
  let executeUpdateId = '';

  const p = () => world.parties;
  const as = (who: keyof TreasuryWorld['parties']) => cookies[who] ?? { cookie: '' };
  const get = (url: string, who?: keyof TreasuryWorld['parties'], app: TreasuryApp = t) =>
    app.app.inject({ method: 'GET', url, ...(who ? { headers: as(who) } : {}) });
  const post = (
    url: string,
    who: keyof TreasuryWorld['parties'] | undefined,
    payload?: unknown,
    app: TreasuryApp = t,
  ) =>
    app.app.inject({
      method: 'POST',
      url,
      ...(who ? { headers: as(who) } : {}),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const errorOf = (res: LightMyRequestResponse) => res.json<ErrorJson>().error;

  beforeAll(async () => {
    await requireSandbox();
    world = await createTreasuryWorld();
    database = createDatabase(DATABASE_URL);
    await resetDatabase(database);
    await runMigrations(database.db);
    const asset = createTestAssetAdapter(world, switches);
    funding = createTestFunding(world, switches);
    t = await buildTreasuryApp(world, database, {
      asset,
      funding,
      cycles,
      routeOptions: { autoReceivePoll: { attempts: 3, delayMs: 50 } },
    });
    const mainnetConfig = {
      ...world.config,
      network: 'mainnet',
      mainnet: {
        explorerTxUrl: 'https://explorer.example/tx/{updateId}',
        groftyMinVersion: '2.0.4',
      },
      localnet: undefined,
    } as Config;
    mainnet = await buildTreasuryApp(world, database, {
      config: mainnetConfig,
      asset,
      funding,
      cycles,
    });
    cookies = {};
    for (const name of Object.keys(world.parties) as (keyof typeof world.parties)[]) {
      cookies[name] = await t.cookieFor(world.parties[name]);
    }
  });

  afterAll(async () => {
    await t.app.close();
    await mainnet.app.close();
    await database.close();
  });

  // -----------------------------------------------------------------------------------------
  it('starts at the organization step while only the charter exists', async () => {
    for (const who of ['treasurer', 'outsider'] as const) {
      const res = await get('/api/org', who);
      expect(res.statusCode).toBe(200);
      expect(OrgResponseSchema.parse(res.json())).toEqual({
        setupStep: 'organization',
        organization: null,
        mandate: null,
      });
    }
    expect((await get('/api/org')).statusCode).toBe(401);
  });

  it('refuses organization setup from the wrong party and for invalid input', async () => {
    const body = {
      name: 'Acme Fund',
      approvers: [p().approver1, p().approver2, p().approver3],
      approvalThreshold: 2,
    };
    const notTreasurer = await post('/api/org', 'outsider', body);
    expect(notTreasurer.statusCode).toBe(403);
    expect(errorOf(notTreasurer).code).toBe('not_treasurer');

    const duplicates = await post('/api/org', 'treasurer', {
      ...body,
      approvers: [p().approver1, p().approver1],
    });
    expect(duplicates.statusCode).toBe(400);
    expect(errorOf(duplicates).code).toBe('duplicate_approver');

    for (const system of [p().agent, p().operator, p().treasury]) {
      const res = await post('/api/org', 'treasurer', {
        ...body,
        approvers: [p().approver1, system],
      });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('invalid_approver');
    }

    const threshold = await post('/api/org', 'treasurer', { ...body, approvalThreshold: 4 });
    expect(threshold.statusCode).toBe(400);
    expect(errorOf(threshold).message).toContain('threshold is 4 but there are only 3 approvers');

    const missingName = await post('/api/org', 'treasurer', { ...body, name: '  ' });
    expect(missingName.statusCode).toBe(400);
    expect(errorOf(missingName).code).toBe('invalid_request');
  });

  it('creates the organization as the treasurer and logs it', async () => {
    const res = await post('/api/org', 'treasurer', {
      name: 'Acme Fund',
      approvers: [p().approver1, p().approver2, p().approver3],
      approvalThreshold: 2,
    });
    expect(res.statusCode).toBe(201);
    const org = OrgResponseSchema.parse(res.json());
    expect(org.setupStep).toBe('policy');
    expect(org.mandate).toBeNull();
    expect(org.organization).toMatchObject({
      name: 'Acme Fund',
      assetSymbol: 'CC',
      approvalThreshold: 2,
      treasurer: { partyId: p().treasurer, displayName: 'Treasurer' },
      treasury: { partyId: p().treasury, displayName: 'Treasury' },
    });
    expect(org.organization?.approvers.map((a) => a.displayName)).toEqual([
      'Approver 1',
      'Approver 2',
      'Approver 3',
    ]);

    // Now the treasurer role exists, and a second attempt is refused.
    const again = await post('/api/org', 'treasurer', {
      name: 'Other',
      approvers: [p().approver1],
      approvalThreshold: 1,
    });
    expect(again.statusCode).toBe(409);
    expect(errorOf(again).code).toBe('organization_exists');

    const activity = ActivityResponseSchema.parse((await get('/api/activity', 'treasurer')).json());
    expect(activity.entries[0]).toMatchObject({
      kind: 'org.created',
      text: 'Treasurer created Acme Fund with 3 approvers, 2 of 3',
      actor: { displayName: 'Treasurer' },
      seeded: false,
    });

    // A party with no role still sees the setup step but nothing of the organization.
    const outsider = OrgResponseSchema.parse((await get('/api/org', 'outsider')).json());
    expect(outsider).toEqual({ setupStep: 'policy', organization: null, mandate: null });
  });

  it('shows the sealed Mandate with names and plain-English terms', async () => {
    // The seal itself is M4's; here the treasurer's request and the treasury's apply go straight to the ledger.
    const { ledger, parties } = world;
    const as = submitter(ledger);
    const asset = { admin: parties.registryAdmin, id: 'CC' };
    const org = await ledger.reader.organization();
    expect(org).not.toBeNull();
    const sealTx = await as.as(
      [parties.treasurer],
      [
        ledger.commands.createMandateSealRequest({
          treasury: parties.treasury,
          treasurer: parties.treasurer,
          agent: parties.agent,
          terms: defaultTerms(asset, [parties.approver1, parties.approver2, parties.approver3]),
          agentExecutes: true,
          summary: 'Test terms',
          summaryFingerprint: '00',
          requestedAt: new Date(),
        }),
      ],
    );
    const sealRequestCid =
      sealTx.events.find(
        (e) => e.kind === 'created' && e.entity === 'Mithra.Mandate:MandateSealRequest',
      )?.contractId ?? '';
    await as.as(
      [parties.treasury],
      [
        ledger.commands.orgApplySeal(org?.contractId ?? '', {
          sealRequestCid,
          currentMandateCid: null,
        }),
      ],
    );

    for (const who of ['treasurer', 'approver1'] as const) {
      const res = await get('/api/org', who);
      expect(res.statusCode).toBe(200);
      const view = OrgResponseSchema.parse(res.json());
      expect(view.setupStep).toBe('done');
      expect(view.mandate).toMatchObject({
        version: 1,
        agentExecutes: true,
        sealedBy: { displayName: 'Treasurer' },
        seal: { required: 1, signed: 1 },
        executedCycles: [],
        terms: {
          cap: '5000.0000000000',
          approvalThreshold: 2,
          assetSymbol: 'CC',
          scheduleText: 'Monthly on the 1st at 09:00 UTC',
          recordDateText: 'Last day of the previous month',
          feeBuffer: '1.0000000000',
        },
      });
      expect(view.mandate?.terms.approvers.map((a) => a.displayName)).toEqual([
        'Approver 1',
        'Approver 2',
        'Approver 3',
      ]);
    }
    // A party with no role yet may read it (setup flow), see the redaction test above.
    expect((await get('/api/org', 'auditor')).statusCode).toBe(200);
  });

  // -----------------------------------------------------------------------------------------
  it('issues units to four holders and shows the holders table', async () => {
    const issue = (holder: string, units: number, extra: object = {}) =>
      post('/api/holders/issue', 'treasurer', {
        holder,
        units,
        effectiveDate: isoDate(daysAgo(40)),
        ...extra,
      });

    // Validation first.
    const future = await issue(p().holderA, 10, {
      effectiveDate: isoDate(new Date(Date.now() + 2 * 86_400_000)),
    });
    expect(future.statusCode).toBe(400);
    expect(errorOf(future).code).toBe('future_date');
    expect((await issue(p().agent, 10)).statusCode).toBe(400);
    expect((await issue(p().holderA, 0)).statusCode).toBe(400);
    expect(
      (await post('/api/holders/issue', 'approver1', { holder: p().holderA, units: 5 })).statusCode,
    ).toBe(403);
    expect(
      (await post('/api/holders/issue', undefined, { holder: p().holderA, units: 5 })).statusCode,
    ).toBe(401);

    for (const [holder, units] of [
      [p().holderA, 100],
      [p().holderB, 300],
      [p().holderC, 600],
    ] as const) {
      expect((await issue(holder, units)).statusCode).toBe(200);
    }
    // The effective date defaults to today.
    const last = await post('/api/holders/issue', 'treasurer', {
      holder: p().holderD,
      units: 1000,
    });
    expect(last.statusCode).toBe(200);
    const fromIssue = HoldersResponseSchema.parse(last.json());
    expect(fromIssue.totalUnits).toBe(2000);

    const res = await get('/api/holders', 'treasurer');
    expect(res.statusCode).toBe(200);
    const table = HoldersResponseSchema.parse(res.json());
    expect(table.totalUnits).toBe(2000);
    expect(table.holders.map((h) => [h.holder.displayName, h.units, h.sharePct])).toEqual([
      ['Holder D', 1000, '50.00'],
      ['Holder C', 600, '30.00'],
      ['Holder B', 300, '15.00'],
      ['Holder A', 100, '5.00'],
    ]);
    expect(table.holders.map((h) => [h.holder.displayName, h.autoReceive])).toEqual([
      ['Holder D', false],
      ['Holder C', true],
      ['Holder B', false],
      ['Holder A', true],
    ]);
    // Nobody accepted yet; nothing paid yet; real (not seeded) data.
    expect(
      table.holders.every((h) => !h.unitsAccepted && h.lastPayment === null && !h.seeded),
    ).toBe(true);

    // Approvers read the table; holders and outsiders do not.
    expect((await get('/api/holders', 'approver1')).statusCode).toBe(200);
    expect((await get('/api/holders', 'holderA')).statusCode).toBe(403);
    expect((await get('/api/holders', 'outsider')).statusCode).toBe(403);
    // A holder is not on the setup flow any more: /api/org is for the treasury team.
    expect((await get('/api/org', 'holderA')).statusCode).toBe(403);

    const activity = ActivityResponseSchema.parse(
      (await get('/api/activity?limit=3', 'treasurer')).json(),
    );
    expect(activity.entries[0]?.text).toBe('Issued 1,000 units to Holder D');
    expect(activity.entries).toHaveLength(3);
    expect((await get('/api/activity?limit=0', 'treasurer')).statusCode).toBe(400);
  });

  it('creates invitations and reads them by code without a session', async () => {
    const created = await post('/api/invites', 'treasurer', {
      kind: 'holder',
      displayName: 'Holder A',
      partyId: p().holderA,
    });
    expect(created.statusCode).toBe(201);
    const invite = InviteSchema.parse(created.json());
    expect(invite.code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    expect(invite).toMatchObject({
      kind: 'holder',
      displayName: 'Holder A',
      path: `/invite/${invite.code}`,
      orgName: 'Acme Fund',
      used: false,
    });
    expect(
      (await post('/api/invites', 'holderA', { kind: 'holder', displayName: 'X' })).statusCode,
    ).toBe(403);
    expect((await post('/api/invites', 'treasurer', { kind: 'holder' })).statusCode).toBe(400);

    // Public: no cookie. The invitee sees the fund, their own name and the units offered to them.
    const read = await get(`/api/invites/${invite.code}`);
    expect(read.statusCode).toBe(200);
    expect(InviteSchema.parse(read.json())).toEqual(invite);
    expect(read.json<{ unitsOffered: number | null }>().unitsOffered).toBe(100);
    for (const other of [p().holderB, p().holderC, p().holderD]) {
      expect(read.body).not.toContain(other);
    }
    // Lower case and padding are tolerated.
    expect((await get(`/api/invites/${invite.code.toLowerCase()}`)).statusCode).toBe(200);

    // An invite without a party (MainNet style) offers no units.
    const open = InviteSchema.parse(
      (
        await post('/api/invites', 'treasurer', { kind: 'auditor', displayName: 'Audit Co' })
      ).json(),
    );
    const openRead = await get(`/api/invites/${open.code}`);
    expect(openRead.json<{ unitsOffered: number | null; kind: string }>()).toMatchObject({
      kind: 'auditor',
      unitsOffered: null,
    });

    const unknown = await get('/api/invites/ZZZZZZZZ');
    expect(unknown.statusCode).toBe(404);
    expect(errorOf(unknown).code).toBe('not_found');
    expect((await get('/api/invites/not-a-code')).statusCode).toBe(404);
  });

  // -----------------------------------------------------------------------------------------
  it('warns about funds when the balance is below the expected total plus the fee buffer', async () => {
    cycles.next = { cycleId: '2026-11', label: 'November 2026', at: '2026-11-01T09:00:00.000Z' };
    cycles.cycles = [
      cycleSummary({
        cycleId: '2026-08',
        total: '999.0000000000',
        createdAt: '2026-08-31T09:00:00.000Z',
      }),
      // The newest executed cycle sets the expected next total: more than the 1,000,000 CC balance.
      cycleSummary({
        cycleId: '2026-09',
        total: '2000000.0000000000',
        createdAt: '2026-09-30T09:00:00.000Z',
      }),
      cycleSummary({
        cycleId: '2026-10',
        status: 'awaiting-approval',
        total: '5.0000000000',
        createdAt: '2026-10-01T09:00:00.000Z',
      }),
      cycleSummary({
        cycleId: '2026-07',
        status: 'rejected',
        total: '8.0000000000',
        createdAt: '2026-07-31T09:00:00.000Z',
      }),
    ];
    const res = await get('/api/overview', 'treasurer');
    expect(res.statusCode).toBe(200);
    const overview = OverviewResponseSchema.parse(res.json());
    expect(overview).toMatchObject({
      assetSymbol: 'CC',
      nextCycle: { cycleId: '2026-11', label: 'November 2026' },
      expectedNextTotal: '2000000.0000000000',
      pendingApprovals: 1,
      mandate: { version: 1 },
    });
    expect(sameDecimal(overview.balance ?? 'x', '1000000')).toBe(true);
    // required = total + fee buffer of 1 CC from the Mandate.
    expect(overview.fundsWarning && sameDecimal(overview.fundsWarning.required, '2000001')).toBe(
      true,
    );
    expect(overview.fundsWarning && sameDecimal(overview.fundsWarning.balance, '1000000')).toBe(
      true,
    );
    expect(overview.recentCycles.map((c) => c.cycleId)).toEqual([
      '2026-10',
      '2026-09',
      '2026-08',
      '2026-07',
    ]);
    expect(overview.recentActivity.length).toBeLessThanOrEqual(10);
    expect(overview.recentActivity[0]?.kind).toBe('invite.created');

    // Approvers see it too; a holder does not.
    expect((await get('/api/overview', 'approver2')).statusCode).toBe(200);
    expect((await get('/api/overview', 'holderA')).statusCode).toBe(403);
  });

  it('has no warning when the balance covers the next total, and a null balance when it cannot be read', async () => {
    cycles.cycles = [cycleSummary({ cycleId: '2026-09', total: '100.0000000000' })];
    const ok = OverviewResponseSchema.parse((await get('/api/overview', 'treasurer')).json());
    expect(ok.fundsWarning).toBeNull();
    expect(ok.expectedNextTotal).toBe('100.0000000000');

    switches.failBalance = true;
    try {
      const res = await get('/api/overview', 'treasurer');
      expect(res.statusCode).toBe(200);
      const down = OverviewResponseSchema.parse(res.json());
      expect(down.balance).toBeNull();
      expect(down.fundsWarning).toBeNull();
    } finally {
      switches.failBalance = false;
    }

    cycles.cycles = [];
    cycles.next = null;
    const empty = OverviewResponseSchema.parse((await get('/api/overview', 'treasurer')).json());
    expect(empty).toMatchObject({
      nextCycle: null,
      expectedNextTotal: null,
      fundsWarning: null,
      pendingApprovals: 0,
      recentCycles: [],
    });
  });

  it('reports the nodes and hosting threshold on the infrastructure panel', async () => {
    const res = await get('/api/infrastructure', 'treasurer');
    expect(res.statusCode).toBe(200);
    const infra = InfrastructureResponseSchema.parse(res.json());
    // Node A is the sandbox (it hosts the treasury); B and C do not answer.
    expect(infra).toEqual({
      treasuryParty: p().treasury,
      hostingThreshold: 2,
      nodes: [
        { id: 'a', name: 'Node A', operator: 'Op A', online: true, hostsTreasury: true },
        { id: 'b', name: 'Node B', operator: 'Op B', online: false, hostsTreasury: false },
        { id: 'c', name: 'Node C', operator: 'Op C', online: false, hostsTreasury: false },
      ],
      summary:
        'Below threshold: 1 of 3 nodes online. Payments and approvals wait until a second node is back.',
    });
    expect((await get('/api/infrastructure', 'holderA')).statusCode).toBe(403);
  });

  it('adds test funds on LocalNet for the treasurer only', async () => {
    const res = await post('/api/treasury/fund', 'treasurer', { amount: '10000' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ amount: string; balance: string; acceptedPending: boolean }>();
    expect(body.amount).toBe('10000');
    expect(sameDecimal(body.balance, '1010000')).toBe(true);
    const activity = ActivityResponseSchema.parse(
      (await get('/api/activity?limit=1', 'treasurer')).json(),
    );
    expect(activity.entries[0]?.text).toBe('Added 10,000 CC to the treasury (LocalNet test funds)');

    expect((await post('/api/treasury/fund', 'treasurer', { amount: '0' })).statusCode).toBe(400);
    expect((await post('/api/treasury/fund', 'treasurer', { amount: 'ten' })).statusCode).toBe(400);
    expect((await post('/api/treasury/fund', 'approver1', { amount: '5' })).statusCode).toBe(403);
    expect(funding.calls.fund).toEqual(['10000']);

    switches.failFunding = true;
    try {
      const failed = await post('/api/treasury/fund', 'treasurer', { amount: '5' });
      expect(failed.statusCode).toBe(502);
      expect(errorOf(failed)).toEqual({
        code: 'funding_failed',
        message: 'The registry refused the transfer to the treasury. Try again.',
      });
    } finally {
      switches.failFunding = false;
    }
  });

  // -----------------------------------------------------------------------------------------
  it('shows a holder their own position and lets them accept units', async () => {
    cycles.next = { cycleId: '2026-11', label: 'November 2026', at: '2026-11-01T09:00:00.000Z' };
    const res = await get('/api/me/position', 'holderA');
    expect(res.statusCode).toBe(200);
    const position = HolderPositionSchema.parse(res.json());
    expect(position).toMatchObject({
      orgName: 'Acme Fund',
      assetSymbol: 'CC',
      units: 100,
      sharePct: '5.00',
      totalReceived: '0.0000000000',
      nextPaymentDate: '2026-11-01',
      autoReceive: true,
      payments: [],
    });
    expect(position.pendingUnits).toHaveLength(1);
    expect(position.pendingUnits[0]).toMatchObject({ units: 100 });

    // Only holders have a position.
    expect((await get('/api/me/position', 'treasurer')).statusCode).toBe(403);
    expect((await get('/api/me/position', 'outsider')).statusCode).toBe(403);
    expect((await get('/api/me/position')).statusCode).toBe(401);

    for (const who of ['holderA', 'holderB'] as const) {
      const pos = HolderPositionSchema.parse((await get('/api/me/position', who)).json());
      unitIds[who] = pos.pendingUnits[0]?.unitId ?? '';
    }
    // B cannot accept A's units: they are not B's, and the answer says nothing about A.
    const crossed = await post(`/api/me/units/${unitIds['holderA']}/accept`, 'holderB');
    expect(crossed.statusCode).toBe(404);
    expect(crossed.body).not.toContain(p().holderA);
    expect(crossed.body).not.toContain('100');

    for (const who of ['holderA', 'holderB'] as const) {
      const accepted = await post(`/api/me/units/${unitIds[who]}/accept`, who);
      expect(accepted.statusCode).toBe(200);
      expect(HolderPositionSchema.parse(accepted.json()).pendingUnits).toEqual([]);
    }
    // Accepting twice is a clean 404, not a ledger error.
    expect((await post(`/api/me/units/${unitIds['holderA']}/accept`, 'holderA')).statusCode).toBe(
      404,
    );

    const table = HoldersResponseSchema.parse((await get('/api/holders', 'treasurer')).json());
    expect(table.holders.map((h) => [h.holder.displayName, h.unitsAccepted])).toEqual([
      ['Holder D', false],
      ['Holder C', false],
      ['Holder B', true],
      ['Holder A', true],
    ]);
    const activity = ActivityResponseSchema.parse(
      (await get('/api/activity?limit=1', 'treasurer')).json(),
    );
    expect(activity.entries[0]?.text).toBe('Holder B accepted 300 units');
  });

  it('runs a distribution through the ledger: A and C are paid at once, B and D get pending transfers', async () => {
    const { ledger, parties, ids } = world;
    const as = submitter(ledger);
    const holdings = [
      { holder: parties.holderA, units: 100 },
      { holder: parties.holderB, units: 300 },
      { holder: parties.holderC, units: 600 },
      { holder: parties.holderD, units: 1000 },
    ];
    const register = await ledger.reader.register();
    const mandate = await ledger.reader.mandate();
    const input = treasuryProposalInput(register?.contractId ?? '', holdings, {
      cycleId: '2026-09',
      total: '1234.5678901234',
    });
    for (const payout of input.payouts) payoutAmounts[payout.holder] = payout.amount;

    const proposeTx = await as.as(
      [parties.agent],
      [ledger.commands.mandatePropose(mandate?.contractId ?? '', input)],
      { readAs: [parties.treasury] },
    );
    const { proposalCid } = choiceResults.mandatePropose(proposeTx);
    const treasuryHoldings = await createTestAssetAdapter(world, switches).holdings(
      parties.treasury,
    );
    const executeTx = await as.as(
      [parties.agent],
      [
        ledger.commands.mandateAgentExecute(mandate?.contractId ?? '', {
          proposalCid,
          legs: input.payouts.map((x) =>
            testLeg(ids.factoryCid, x.holder, ids.preapprovals[x.holder]),
          ),
          inputHoldingCids: treasuryHoldings.map((h) => h.contractId),
          executeBefore: new Date(Date.now() + 24 * 60 * 60 * 1000),
        }),
      ],
      { readAs: [parties.treasury] },
    );
    executeUpdateId = executeTx.updateId;

    const payments = await ledger.reader.payments();
    expect(payments).toHaveLength(4);
    for (const payment of payments) {
      paymentCids[payment.payload.holder] = payment.contractId;
      paymentIds[payment.payload.holder] = opaqueId(payment.contractId);
      // The engine records the transaction of each payment for explorer links (P3).
      await database.db
        .insert(txRefs)
        .values({ contractId: payment.contractId, updateId: executeUpdateId, kind: 'payment' });
    }
    expect(payments.find((x) => x.payload.holder === parties.holderA)?.payload.status).toBe('Paid');
    expect(payments.find((x) => x.payload.holder === parties.holderB)?.payload.status).toBe(
      'AwaitingAcceptance',
    );
    expect(payments.find((x) => x.payload.holder === parties.holderC)?.payload.status).toBe('Paid');
    expect(payments.find((x) => x.payload.holder === parties.holderD)?.payload.status).toBe(
      'AwaitingAcceptance',
    );

    // The treasurer's table now shows the last payment of each holder.
    const table = HoldersResponseSchema.parse((await get('/api/holders', 'treasurer')).json());
    const a = table.holders.find((h) => h.holder.partyId === parties.holderA);
    expect(a?.lastPayment).toMatchObject({
      amount: payoutAmounts[parties.holderA],
      cycleLabel: 'Cycle 2026-09',
    });
  });

  it('L7/U7: holder A sees nothing of holder B', async () => {
    const { parties } = world;
    const others = (own: string) =>
      [parties.holderA, parties.holderB, parties.holderC, parties.holderD].filter((x) => x !== own);

    const resA = await get('/api/me/position', 'holderA');
    expect(resA.statusCode).toBe(200);
    const posA = HolderPositionSchema.parse(resA.json());
    const resB = await get('/api/me/position', 'holderB');
    const posB = HolderPositionSchema.parse(resB.json());

    // A: one payment, theirs, paid, with its in-app transaction link.
    expect(posA.units).toBe(100);
    expect(posA.payments).toHaveLength(1);
    expect(posA.payments[0]).toMatchObject({
      paymentId: paymentIds[parties.holderA],
      status: 'paid',
      cycleLabel: 'Cycle 2026-09',
      link: { updateId: executeUpdateId, href: `/holder/tx/${executeUpdateId}`, external: false },
    });
    expect(
      sameDecimal(posA.payments[0]?.amount ?? 'x', payoutAmounts[parties.holderA] ?? 'y'),
    ).toBe(true);
    expect(sameDecimal(posA.totalReceived, payoutAmounts[parties.holderA] ?? 'y')).toBe(true);
    // B: one payment, theirs, waiting for them to accept; nothing received yet.
    expect(posB.units).toBe(300);
    expect(posB.payments.map((x) => [x.paymentId, x.status])).toEqual([
      [paymentIds[parties.holderB], 'awaiting-acceptance'],
    ]);
    expect(sameDecimal(posB.totalReceived, '0')).toBe(true);

    // The text of each response holds no other holder's party id, name or amount, anywhere.
    for (const [own, res] of [
      [parties.holderA, resA],
      [parties.holderB, resB],
    ] as const) {
      for (const other of others(own)) {
        expect(res.body).not.toContain(other);
        // A short, unique prefix of the amount (to whole units and a few decimals).
        expect(res.body).not.toContain((payoutAmounts[other] ?? 'missing').slice(0, 8));
      }
      for (const name of ['Holder A', 'Holder B', 'Holder C', 'Holder D'].filter(
        (n) => !own.startsWith(`holder${n.slice(-1)}`),
      )) {
        expect(res.body).not.toContain(name);
      }
      expect(res.body).not.toContain(parties.treasury);
    }
    expect(resA.body).toContain(payoutAmounts[parties.holderA]?.slice(0, 8));

    // A cannot accept B's payment: the ledger shows A nothing of it, so it is a plain 404.
    const attempt = await post(`/api/me/payments/${paymentIds[parties.holderB]}/accept`, 'holderA');
    expect(attempt.statusCode).toBe(404);
    expect(errorOf(attempt).code).toBe('not_found');
    expect(attempt.body).not.toContain(parties.holderB);
    expect(attempt.body).not.toContain((payoutAmounts[parties.holderB] ?? 'missing').slice(0, 8));
    // Nor A's own, already paid, payment.
    expect(
      (await post(`/api/me/payments/${paymentIds[parties.holderA]}/accept`, 'holderA')).statusCode,
    ).toBe(404);
    // B's payment is still waiting.
    const stillB = HolderPositionSchema.parse((await get('/api/me/position', 'holderB')).json());
    expect(stillB.payments[0]?.status).toBe('awaiting-acceptance');

    // Treasury-team routes are closed to holders, and the refusal names no one.
    for (const url of ['/api/holders', '/api/overview', '/api/activity', '/api/infrastructure']) {
      const res = await get(url, 'holderA');
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain(parties.holderB);
    }

    // Live events about holders reach that holder only.
    const holderEvents = t.published.filter((e) => e.event.type === 'holder');
    expect(holderEvents.length).toBeGreaterThan(0);
    for (const e of holderEvents) {
      expect(e.audience.roles).toBeUndefined();
      expect(e.audience.parties).toHaveLength(1);
    }
  });

  it('gives holders generic errors, whether the ledger or the registry fails', async () => {
    const { parties } = world;
    const secrets = [parties.holderB, parties.holderC, 'Holder B', '185.18'];
    try {
      switches.acceptContext = 'registry';
      const registry = await post(
        `/api/me/payments/${paymentIds[parties.holderD]}/accept`,
        'holderD',
      );
      expect(registry.statusCode).toBe(502);
      expect(errorOf(registry)).toEqual({
        code: 'registry_unavailable',
        message:
          'Accepting this payment did not go through because the token registry did not answer. Try again in a minute.',
      });
      for (const secret of secrets) expect(registry.body).not.toContain(secret);

      // A disclosed contract the ledger does not know makes the ledger reject the submission.
      switches.acceptContext = 'ledger';
      const ledger = await post(
        `/api/me/payments/${paymentIds[parties.holderD]}/accept`,
        'holderD',
      );
      expect(ledger.statusCode).toBe(422);
      expect(errorOf(ledger).message).toMatch(
        /^Accepting this payment (failed|did not go through)/,
      );
      expect(ledger.body).not.toContain('00bogus');
      for (const secret of secrets) expect(ledger.body).not.toContain(secret);
    } finally {
      switches.acceptContext = 'ok';
    }
  });

  it('lets a holder accept a pending payment, which the ledger then settles', async () => {
    const { parties } = world;
    const asset = createTestAssetAdapter(world, switches);
    expect(await asset.balance(parties.holderB)).toMatch(/^0/);
    const res = await post(`/api/me/payments/${paymentIds[parties.holderB]}/accept`, 'holderB');
    expect(res.statusCode).toBe(200);
    HolderPositionSchema.parse(res.json());
    // The transfer completed on the ledger: the funds are B's.
    expect(
      sameDecimal(await asset.balance(parties.holderB), payoutAmounts[parties.holderB] ?? 'x'),
    ).toBe(true);

    // The payment says awaiting acceptance until the engine's reconciler marks it Paid (here, by hand as the agent).
    const before = HolderPositionSchema.parse((await get('/api/me/position', 'holderB')).json());
    expect(before.payments[0]?.status).toBe('awaiting-acceptance');
    await submitter(world.ledger).as(
      [parties.agent],
      [world.ledger.commands.paymentMarkAccepted(paymentCids[parties.holderB] ?? '')],
      { readAs: [parties.treasury] },
    );
    const after: HolderPosition = HolderPositionSchema.parse(
      (await get('/api/me/position', 'holderB')).json(),
    );
    expect(after.payments.map((x) => x.status)).toEqual(['paid']);
    expect(sameDecimal(after.totalReceived, payoutAmounts[parties.holderB] ?? 'x')).toBe(true);

    // Accepting it again is refused cleanly.
    expect(
      (await post(`/api/me/payments/${paymentIds[parties.holderB]}/accept`, 'holderB')).statusCode,
    ).toBe(404);
    const activity = ActivityResponseSchema.parse(
      (await get('/api/activity?limit=1', 'treasurer')).json(),
    );
    expect(activity.entries[0]?.kind).toBe('payment.accepted');
  });

  it('turns on auto-receive through the registry preapproval', async () => {
    const { parties } = world;
    // A already has it: nothing is created.
    funding.calls.preapproval.length = 0;
    const already = await post('/api/me/auto-receive', 'holderA');
    expect(already.statusCode).toBe(200);
    expect(HolderPositionSchema.parse(already.json()).autoReceive).toBe(true);
    expect(funding.calls.preapproval).toEqual([]);

    // The registry does not report it in time: a clear 409, and the holder can try again.
    switches.skipPreapproval = true;
    try {
      const slow = await post('/api/me/auto-receive', 'holderD');
      expect(slow.statusCode).toBe(409);
      expect(errorOf(slow).code).toBe('auto_receive_pending');
    } finally {
      switches.skipPreapproval = false;
    }

    const res = await post('/api/me/auto-receive', 'holderD');
    expect(res.statusCode).toBe(200);
    expect(HolderPositionSchema.parse(res.json()).autoReceive).toBe(true);
    expect(funding.calls.preapproval.filter((x) => x === parties.holderD)).toHaveLength(2);

    const table = HoldersResponseSchema.parse((await get('/api/holders', 'treasurer')).json());
    expect(table.holders.find((h) => h.holder.partyId === parties.holderD)?.autoReceive).toBe(true);
    const activity = ActivityResponseSchema.parse(
      (await get('/api/activity?limit=1', 'treasurer')).json(),
    );
    expect(activity.entries[0]?.text).toBe('Holder D turned on auto-receive');
  });

  // -----------------------------------------------------------------------------------------
  it('on MainNet, user-signed writes say to sign in Grofty and payment links go to the explorer', async () => {
    const { parties } = world;
    const treasurerCookie = await mainnet.cookieFor(parties.treasurer);
    const holderACookie = await mainnet.cookieFor(parties.holderA);
    const asTreasurer = { headers: treasurerCookie };
    const asHolderA = { headers: holderACookie };

    const expected = { error: { code: 'sign_in_wallet', message: SIGN_IN_WALLET_MESSAGE } };
    expect(SIGN_IN_WALLET_MESSAGE).toBe(
      'On MainNet this is signed in Grofty Wallet. Open it from the button on this page.',
    );
    const org = await mainnet.app.inject({
      method: 'POST',
      url: '/api/org',
      ...asTreasurer,
      payload: { name: 'Acme', approvers: [parties.approver1], approvalThreshold: 1 },
    });
    expect(org.statusCode).toBe(409);
    expect(org.json()).toEqual(expected);
    const issue = await mainnet.app.inject({
      method: 'POST',
      url: '/api/holders/issue',
      ...asTreasurer,
      payload: { holder: parties.holderA, units: 5 },
    });
    expect(issue.json()).toEqual(expected);
    const units = await mainnet.app.inject({
      method: 'POST',
      url: '/api/me/units/any/accept',
      ...asHolderA,
    });
    expect(units.json()).toEqual(expected);
    const fund = await mainnet.app.inject({
      method: 'POST',
      url: '/api/treasury/fund',
      ...asTreasurer,
      payload: { amount: '5' },
    });
    expect(fund.statusCode).toBe(404);
    expect(fund.json<ErrorJson>().error.code).toBe('not_available');

    // Infrastructure has no nodes on MainNet.
    const infra = InfrastructureResponseSchema.parse(
      (
        await mainnet.app.inject({ method: 'GET', url: '/api/infrastructure', ...asTreasurer })
      ).json(),
    );
    expect(infra).toMatchObject({
      nodes: [],
      summary: "Hosted by the operator's validator on MainNet",
    });

    // A holder's payments come from the agent's view, kept to their own, with explorer links.
    const res = await mainnet.app.inject({ method: 'GET', url: '/api/me/position', ...asHolderA });
    expect(res.statusCode).toBe(200);
    const position = HolderPositionSchema.parse(res.json());
    expect(position.payments).toHaveLength(1);
    expect(position.payments[0]?.link).toEqual({
      updateId: executeUpdateId,
      href: `https://explorer.example/tx/${executeUpdateId}`,
      external: true,
    });
    expect(res.body).not.toContain(parties.holderB);

    // Auto-receive only verifies on MainNet: no preapproval is created by the backend.
    funding.calls.preapproval.length = 0;
    const verify = await mainnet.app.inject({
      method: 'POST',
      url: '/api/me/auto-receive',
      ...asHolderA,
    });
    expect(verify.statusCode).toBe(200);
    expect(funding.calls.preapproval).toEqual([]);
  });
});
