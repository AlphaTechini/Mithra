import {
  AuditRequestDetailSchema,
  AuditRequestsResponseSchema,
  EvidenceRoomSchema,
  type AuditRequestDetail,
  type EvidenceRoom,
} from '@mithra/shared';
import { and, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REQUEST_ID_PATTERN, grantIdOf } from '../../src/audit/service';
import { rulesScope } from '../../src/audit/scope';
import { startGrantExpiry, type GrantExpiry } from '../../src/audit/expiry';
import type { Config } from '../../src/config/env';
import type { CycleModule } from '../../src/cycle';
import { createDatabase, runMigrations, type DatabaseHandle } from '../../src/db';
import { activityLog, txRefs } from '../../src/db/schema';
import { LedgerError } from '../../src/ledger';
import { SIGN_IN_WALLET_MESSAGE } from '../../src/audit/service';
import { buildAuditApp, DATABASE_URL_M9, inviteAuditor, type AuditApp } from './auditHelpers';
import {
  createCycleWorld,
  daysAgo,
  isoDate,
  issueUnits,
  makeModule,
  sleep,
  type CycleWorld,
} from './cycleHelpers';
import { requireSandbox, resetDatabase } from './helpers';

const QUESTION = 'Show all Q3 distributions and the approvals behind any flagged one.';

interface ErrorJson {
  error: { code: string; message: string };
}

describe('audit flow against a Canton sandbox and PostgreSQL', () => {
  let database: DatabaseHandle;
  let world: CycleWorld;
  let cycles: CycleModule;
  let t: AuditApp;
  /** Same routes, but "24 hours" lasts 2 seconds (for the expiry tests). */
  let short: AuditApp;
  let mainnet: AuditApp;
  let cookies: Record<string, { cookie: string }>;
  let expiry: GrantExpiry | null = null;

  const p = () => world.parties;
  const as = (who: keyof CycleWorld['parties']) => cookies[who] ?? { cookie: '' };
  const get = (url: string, who?: keyof CycleWorld['parties'], app: AuditApp = t) =>
    app.app.inject({ method: 'GET', url, ...(who ? { headers: as(who) } : {}) });
  const post = (
    url: string,
    who: keyof CycleWorld['parties'] | undefined,
    payload?: unknown,
    app: AuditApp = t,
  ) =>
    app.app.inject({
      method: 'POST',
      url,
      ...(who ? { headers: as(who) } : {}),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const errorOf = (res: LightMyRequestResponse) => res.json<ErrorJson>().error;
  const detailOf = (res: LightMyRequestResponse): AuditRequestDetail =>
    AuditRequestDetailSchema.parse(res.json());
  const grantUrl = (grantId: string, tail: string) =>
    `/api/audit/grants/${encodeURIComponent(grantId)}/${tail}`;
  const activityTexts = async () => (await t.activity.list(500)).map((e) => e.text);
  const holderParties = () => [p().holderA, p().holderB, p().holderC, p().holderD];

  // Filled in as the tests run.
  let scopeItems: { recordId: string; kind: 'decision' | 'outcome'; reason: string }[] = [];
  let requestId = '';
  let grantId = '';
  let flaggedUpdateIds: string[] = [];

  async function createRequest(
    who: keyof CycleWorld['parties'],
    items: typeof scopeItems,
    question = QUESTION,
  ): Promise<AuditRequestDetail> {
    const res = await post('/api/audit/requests', who, {
      question,
      items,
      excluded: 'Holder identities are shown as Holder A to D unless you ask for them',
    });
    expect(res.statusCode, res.body).toBe(200);
    return detailOf(res);
  }

  beforeAll(async () => {
    await requireSandbox();
    database = createDatabase(DATABASE_URL_M9);
    await resetDatabase(database);
    await runMigrations(database.db);

    // The fund: charter, organization, sealed Mandate, units, then two executed cycles (Q3):
    // July is clean, September is flagged (a deviation and a unit spike) and needs 2 approvals.
    world = await createCycleWorld(database, {
      holders: [
        { name: 'holderA', units: 500, daysAgo: 90, preapproval: true },
        { name: 'holderB', units: 400, daysAgo: 90, preapproval: true },
        { name: 'holderC', units: 100, daysAgo: 90, preapproval: true },
        { name: 'holderD', units: 100, daysAgo: 90, preapproval: true },
      ],
      funds: '1000000',
    });
    await issueUnits(world, 'holderC', 900, 5);
    cycles = makeModule(world);
    await cycles.cycles.run({
      trigger: 'manual',
      triggerDetail: 'Run cycle now by Treasurer',
      actorParty: p().treasurer,
      cycleId: '2026-07',
      total: '100',
      recordDate: isoDate(daysAgo(20)),
    });
    await cycles.cycles.settled();
    await sleep(1300);
    expect((await cycles.reconciler.reconcileOnce()).executed).toEqual(['2026-07']);
    await cycles.cycles.run({
      trigger: 'manual',
      triggerDetail: 'Run cycle now by Treasurer',
      actorParty: p().treasurer,
      cycleId: '2026-09',
      total: '1000',
      recordDate: isoDate(daysAgo(1)),
    });
    await cycles.cycles.settled();
    await cycles.cycles.approve('proposal/2026-09/1', p().approver1, 'Checked the unit change');
    await cycles.cycles.approve('proposal/2026-09/1', p().approver2, 'Agreed');
    await cycles.cycles.settled();
    expect((await cycles.cycles.getCycle('2026-09')).summary.status).toBe('paid-after-approval');

    t = await buildAuditApp(world, database);
    short = await buildAuditApp(world, database, {
      durationsMs: { '24h': 2000, '7d': 7 * 24 * 3600_000, '30d': 30 * 24 * 3600_000 },
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
    mainnet = await buildAuditApp(world, database, { config: mainnetConfig });

    await inviteAuditor(database, p().auditor, 'Auditor');
    await inviteAuditor(database, p().outsider, 'Newcomer');
    cookies = {};
    for (const who of [
      'treasurer',
      'approver1',
      'holderA',
      'auditor',
      'outsider',
      'prospect',
    ] as const) {
      cookies[who] = await t.cookieFor(p()[who]);
    }
  });

  afterAll(async () => {
    expiry?.stop();
    cycles?.cycles.dispose();
    await Promise.all([t?.app.close(), short?.app.close(), mainnet?.app.close()]);
    await database?.close();
  });

  it('a made-up grant has no evidence room: 404, and nothing is logged', async () => {
    const res = await get(grantUrl('grant/audit-20260101-zzzzzz', 'evidence'), 'auditor');
    expect(res.statusCode).toBe(404);
    expect(errorOf(res).code).toBe('not_found');
    // Also without the prefix, and from someone with no auditor role at all.
    expect((await get(grantUrl('audit-20260101-zzzzzz', 'evidence'), 'auditor')).statusCode).toBe(
      404,
    );
    expect(
      (await get(grantUrl('grant/audit-20260101-zzzzzz', 'evidence'), 'holderA')).statusCode,
    ).toBe(403);
    expect((await get(grantUrl('grant/audit-20260101-zzzzzz', 'evidence'))).statusCode).toBe(401);
    expect((await activityTexts()).some((t) => t.includes('opened the evidence room'))).toBe(false);
  });

  it('roles: approvers and holders get 403, the treasurer and auditors get empty lists, a treasurer cannot ask for access', async () => {
    for (const who of ['approver1', 'holderA'] as const) {
      const res = await get('/api/audit/requests', who);
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).code).toBe('forbidden_role');
    }
    for (const who of ['treasurer', 'auditor', 'outsider'] as const) {
      const res = await get('/api/audit/requests', who);
      expect(res.statusCode).toBe(200);
      expect(AuditRequestsResponseSchema.parse(res.json()).requests).toEqual([]);
    }
    const asTreasurer = await post('/api/audit/requests', 'treasurer', {
      question: QUESTION,
      items: [{ recordId: 'decision/2026-09/1', kind: 'decision', reason: 'x' }],
      excluded: '',
    });
    expect(asTreasurer.statusCode).toBe(403);
  });

  it('A8: the catalog lists the decision records and outcomes, and the rules draft the scope of the demo question', async () => {
    const catalog = await t.module.catalog();
    expect(catalog.map((e) => [e.recordId, e.flagged])).toEqual([
      ['decision/2026-07/1', false],
      ['outcome/2026-07/1', false],
      ['decision/2026-09/1', true],
      ['outcome/2026-09/1', true],
    ]);
    expect(catalog.every((e) => e.executedAt !== null)).toBe(true);
    expect(t.module.catalog.labelFor('decision/2026-09/1')).toBe('Decision record, September 2026');

    // The rules fallback (no model): every Q3 outcome, and the decision of the flagged cycle.
    const draft = rulesScope(QUESTION, catalog);
    expect(draft.source).toBe('rules');
    expect(draft.items.map((i) => i.recordId)).toEqual([
      'outcome/2026-07/1',
      'decision/2026-09/1',
      'outcome/2026-09/1',
    ]);
    scopeItems = draft.items.map((i) => ({
      recordId: i.recordId,
      kind: i.kind as 'decision' | 'outcome',
      reason: i.reason,
    }));
  });

  it('the auditor asks: the request is on the ledger, with a scope, labels and activity entries', async () => {
    const bad = await post('/api/audit/requests', 'auditor', {
      question: QUESTION,
      items: [{ recordId: 'decision/2026-12/1', kind: 'decision', reason: 'x' }],
      excluded: '',
    });
    expect(bad.statusCode).toBe(400);
    expect(errorOf(bad).code).toBe('unknown_record');
    expect(
      (await post('/api/audit/requests', 'auditor', { question: '', items: [], excluded: '' }))
        .statusCode,
    ).toBe(400);

    const detail = await createRequest('auditor', scopeItems);
    requestId = detail.request.requestId;
    expect(requestId).toMatch(REQUEST_ID_PATTERN);
    expect(detail.request).toMatchObject({
      status: 'pending',
      question: QUESTION,
      auditor: { partyId: p().auditor, displayName: 'Auditor' },
      grant: null,
      denial: null,
    });
    expect(detail.preview).toBeNull();
    expect(detail.request.scope.map((s) => [s.recordId, s.kind, s.label])).toEqual([
      ['outcome/2026-07/1', 'outcome', 'Outcome, July 2026'],
      ['decision/2026-09/1', 'decision', 'Decision record, September 2026'],
      ['outcome/2026-09/1', 'outcome', 'Outcome, September 2026'],
    ]);
    expect(detail.request.scope[1]?.reason).toContain('September 2026');

    const onLedger = await world.ledger.reader.auditRequests();
    expect(onLedger).toHaveLength(1);
    expect(onLedger[0]?.payload).toMatchObject({
      requestId,
      auditor: p().auditor,
      treasurer: p().treasurer,
    });

    const texts = await activityTexts();
    expect(texts).toContain(`Auditor Auditor requested access: ${QUESTION}`);
    expect(texts).toContain('Scope: 3 records proposed');
    // The audit events go to the treasurer and the auditor of the request, and to nobody else.
    const events = t.published.filter((e) => e.event.type === 'audit');
    expect(events).toHaveLength(1);
    expect(events[0]?.audience).toEqual({ parties: [p().treasurer, p().auditor] });
  });

  it('the treasurer sees the request and exactly the records that would be shared; the auditor sees no preview', async () => {
    const list = AuditRequestsResponseSchema.parse(
      (await get('/api/audit/requests', 'treasurer')).json(),
    );
    expect(list.requests.map((r) => [r.requestId, r.status])).toEqual([[requestId, 'pending']]);

    const res = await get(`/api/audit/requests/${requestId}`, 'treasurer');
    expect(res.statusCode).toBe(200);
    const detail = detailOf(res);
    expect(detail.request.question).toBe(QUESTION);
    expect(detail.preview?.map((r) => [r.recordId, r.summary, r.available])).toEqual([
      ['outcome/2026-07/1', 'Executed: 100 CC to 4 holders, within mandate', true],
      ['decision/2026-09/1', '1,000 CC to 4 holders, flagged, approved 2 of 3', true],
      ['outcome/2026-09/1', 'Executed: 1,000 CC to 4 holders, flagged, approved 2 of 3', true],
    ]);

    const own = detailOf(await get(`/api/audit/requests/${requestId}`, 'auditor'));
    expect(own.preview).toBeNull();
    expect((await get('/api/audit/requests/audit-20260101-nothing', 'treasurer')).statusCode).toBe(
      404,
    );
  });

  it('L8: before the grant the auditor sees nothing on the ledger, and the evidence room is closed', async () => {
    const own = world.ledger.reader.as([p().auditor]);
    expect(await own.sharedRecords(p().auditor)).toEqual([]);
    expect(await own.decisionRecords()).toEqual([]);
    expect(await own.outcomes()).toEqual([]);
    expect(await own.auditRequests()).toHaveLength(1);
    expect((await get(grantUrl(grantIdOf(requestId), 'evidence'), 'auditor')).statusCode).toBe(404);
  });

  it('a second auditor sees nothing of the request: 404, never 403 with details', async () => {
    expect((await get(`/api/audit/requests/${requestId}`, 'outsider')).statusCode).toBe(404);
    expect(
      AuditRequestsResponseSchema.parse((await get('/api/audit/requests', 'outsider')).json())
        .requests,
    ).toEqual([]);
    expect((await post(`/api/audit/requests/${requestId}/withdraw`, 'outsider')).statusCode).toBe(
      404,
    );
    expect((await get(grantUrl(grantIdOf(requestId), 'evidence'), 'outsider')).statusCode).toBe(
      404,
    );
    // Neither the auditor nor an approver can answer the request.
    expect(
      (await post(`/api/audit/requests/${requestId}/grant`, 'auditor', { expiresIn: '7d' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await post(`/api/audit/requests/${requestId}/deny`, 'approver1', { reason: 'no' }))
        .statusCode,
    ).toBe(403);
  });

  it('the treasurer grants 7 days for a subset of the scope; records outside the scope are refused', async () => {
    const outside = await post(`/api/audit/requests/${requestId}/grant`, 'treasurer', {
      expiresIn: '7d',
      recordIds: ['decision/2026-07/1'],
    });
    expect(outside.statusCode).toBe(400);
    expect(errorOf(outside).code).toBe('record_not_in_scope');
    expect(
      (await post(`/api/audit/requests/${requestId}/grant`, 'treasurer', { expiresIn: '1h' }))
        .statusCode,
    ).toBe(400);

    const before = Date.now();
    const res = await post(`/api/audit/requests/${requestId}/grant`, 'treasurer', {
      expiresIn: '7d',
      recordIds: ['decision/2026-09/1', 'outcome/2026-09/1'],
    });
    expect(res.statusCode, res.body).toBe(200);
    const detail = detailOf(res);
    expect(detail.request.status).toBe('granted');
    expect(detail.preview).toHaveLength(3);
    const grant = detail.request.grant;
    expect(grant?.grantId).toBe(grantIdOf(requestId));
    expect(grant?.recordIds.sort()).toEqual(['decision/2026-09/1', 'outcome/2026-09/1']);
    expect(grant?.closedAt).toBeNull();
    const sevenDays = 7 * 24 * 3600_000;
    const expires = Date.parse(grant?.expiresAt ?? '');
    expect(expires).toBeGreaterThanOrEqual(before + sevenDays - 1000);
    expect(expires).toBeLessThanOrEqual(Date.now() + sevenDays + 1000);
    grantId = grant?.grantId ?? '';

    // The scope (with reasons) is kept for the request although the ledger dropped it.
    expect(detail.request.scope).toHaveLength(3);
    expect(detail.request.scope[1]?.reason).toContain('September 2026');
    expect(detail.request.question).toBe(QUESTION);

    const texts = await activityTexts();
    expect(
      texts.some((x) => /^Access granted to Auditor until \d+ \w+ \d{4} \(2 records\)$/.test(x)),
    ).toBe(true);
    // A second answer is refused: the request is no longer pending.
    const again = await post(`/api/audit/requests/${requestId}/grant`, 'treasurer', {
      expiresIn: '7d',
    });
    expect(again.statusCode).toBe(409);
    expect(errorOf(again).code).toBe('request_not_pending');
    const events = t.published.filter((e) => e.event.type === 'audit');
    expect(events.every((e) => e.audience.parties?.length === 2)).toBe(true);
  });

  it('L8: the auditor opens an evidence room with exactly the granted records, built from their own SharedRecord contracts, and no holder party id', async () => {
    // Ledger: exactly one SharedRecord per granted record, visible to the auditor.
    const shared = await world.ledger.reader.as([p().auditor]).sharedRecords(p().auditor);
    expect(shared.map((r) => r.payload.recordId).sort()).toEqual([
      'decision/2026-09/1',
      'outcome/2026-09/1',
    ]);

    const res = await get(grantUrl(grantId, 'evidence'), 'auditor');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const room: EvidenceRoom = EvidenceRoomSchema.parse(res.json());
    expect(room).toMatchObject({ grantId, question: QUESTION });
    expect(room.records.map((r) => r.recordId)).toEqual([
      'decision/2026-09/1',
      'outcome/2026-09/1',
    ]);

    // Not one holder party id (nor its namespace) appears anywhere in the evidence JSON.
    const json = JSON.stringify(room);
    for (const holder of holderParties()) {
      expect(json).not.toContain(holder);
      expect(json).not.toContain(holder.split('::')[0] ?? 'x');
    }
    expect(json).not.toContain(p().treasury);
    expect(json).not.toContain(p().treasurer);

    const decision = room.records[0]?.decision;
    expect(decision).toMatchObject({
      verdict: 'needs-approval',
      total: '1000.0000000000',
      mandateVersion: 1,
    });
    expect(decision?.payouts.map((x) => x.holderLabel)).toEqual([
      'Holder A',
      'Holder B',
      'Holder C',
      'Holder D',
    ]);
    expect(decision?.payouts.reduce((n, x) => n + x.units, 0)).toBe(2000);
    expect(decision?.inputFingerprints.length).toBeGreaterThan(0);
    expect(decision?.inputFingerprints.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
    expect(decision?.checks.some((c) => !c.passed && c.blocking)).toBe(true);
    expect(decision?.memo).toContain('checks flagged');

    const outcome = room.records[1]?.outcome;
    expect(outcome?.kind).toBe('executed');
    expect(outcome?.approvals.map((a) => [a.approverLabel, a.note])).toEqual([
      ['Approver 1', 'Checked the unit change'],
      ['Approver 2', 'Agreed'],
    ]);
    // Payments carry the same labels as the decision, and a link to the transaction.
    expect(outcome?.payments.map((x) => x.holderLabel)).toEqual([
      'Holder A',
      'Holder B',
      'Holder C',
      'Holder D',
    ]);
    expect(outcome?.payments.every((x) => x.status === 'paid')).toBe(true);
    flaggedUpdateIds = (outcome?.payments ?? []).map((x) => x.link?.updateId ?? '');
    expect(flaggedUpdateIds.every((id) => id !== '')).toBe(true);
    expect(outcome?.payments[0]?.link?.href).toBe(
      `/auditor/tx/${encodeURIComponent(flaggedUpdateIds[0] ?? '')}`,
    );
    const refs = await database.db.select().from(txRefs).where(eq(txRefs.kind, 'payment'));
    for (const id of flaggedUpdateIds) expect(refs.map((r) => r.updateId)).toContain(id);

    // The prefix may be left out of the path.
    expect((await get(`/api/audit/grants/${requestId}/evidence`, 'auditor')).statusCode).toBe(200);
    // Another auditor cannot open it, and neither can the treasurer.
    expect((await get(grantUrl(grantId, 'evidence'), 'outsider')).statusCode).toBe(404);
    expect((await get(grantUrl(grantId, 'evidence'), 'treasurer')).statusCode).toBe(403);
  });

  it('every view is logged: one session entry within 10 minutes, however many requests', async () => {
    const views = (await activityTexts()).filter((x) => x.includes('opened the evidence room'));
    expect(views).toEqual(['Auditor Auditor opened the evidence room (2 records)']);
    const rows = await database.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.kind, 'audit.viewed'), eq(activityLog.subject, grantId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorParty).toBe(p().auditor);
  });

  it('exports a Markdown summary for working papers, with holder labels and no party ids', async () => {
    const res = await get(grantUrl(grantId, 'export'), 'auditor');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    const disposition = String(res.headers['content-disposition']);
    expect(disposition).toMatch(/^attachment; filename="mithra-evidence-[A-Za-z0-9._-]+\.md"$/);
    expect(disposition).toContain(requestId);
    expect(res.body).toContain(QUESTION);
    expect(res.body).toContain('decision/2026-09/1');
    expect(res.body).toContain('Holder C');
    expect(res.body).toContain('Approver 1');
    for (const holder of holderParties()) expect(res.body).not.toContain(holder);
    expect((await get(grantUrl(grantId, 'export'), 'outsider')).statusCode).toBe(404);
  });

  it('L9: the agent cannot close a grant before its expiry', async () => {
    const grant = (await world.ledger.reader.grants()).find((g) => g.payload.grantId === grantId);
    expect(grant).toBeDefined();
    await expect(
      world.ledger.client.submit({
        actAs: [p().agent],
        readAs: [p().treasury],
        commands: [
          world.ledger.commands.accessGrantCloseExpired(grant?.contractId ?? '', {
            closer: p().agent,
          }),
        ],
        shape: 'LEDGER_EFFECTS',
      }),
    ).rejects.toBeInstanceOf(LedgerError);
    // Nothing changed for the auditor.
    expect(await world.ledger.reader.as([p().auditor]).sharedRecords(p().auditor)).toHaveLength(2);
  });

  it('the treasurer revokes: the grant closes, the auditor gets 410 and sees no SharedRecord', async () => {
    expect((await post(grantUrl(grantId, 'revoke'), 'auditor')).statusCode).toBe(403);
    const res = await post(grantUrl(grantId, 'revoke'), 'treasurer');
    expect(res.statusCode, res.body).toBe(200);
    const detail = detailOf(res);
    expect(detail.request.status).toBe('ended');
    expect(detail.request.grant).toMatchObject({ grantId, closedReason: 'revoked' });
    expect(detail.request.grant?.closedAt).not.toBeNull();
    // The dates and records of the grant are kept for the history.
    expect(detail.request.grant?.recordIds.sort()).toEqual([
      'decision/2026-09/1',
      'outcome/2026-09/1',
    ]);
    expect(Date.parse(detail.request.grant?.expiresAt ?? '')).toBeGreaterThan(Date.now());

    const gone = await get(grantUrl(grantId, 'evidence'), 'auditor');
    expect(gone.statusCode).toBe(410);
    expect(errorOf(gone).code).toBe('access_ended');
    expect(errorOf(gone).message).toMatch(
      /^Access ended \d{1,2} \w+ \d{4}\. Ask the fund for a new grant if you need these records again\.$/,
    );
    expect((await get(grantUrl(grantId, 'export'), 'auditor')).statusCode).toBe(410);
    expect(await world.ledger.reader.as([p().auditor]).sharedRecords(p().auditor)).toEqual([]);
    expect(await world.ledger.reader.as([p().auditor]).decisionRecords()).toEqual([]);

    // Revoking twice says so; the auditor's list shows the ended request.
    const twice = await post(grantUrl(grantId, 'revoke'), 'treasurer');
    expect(twice.statusCode).toBe(409);
    expect(errorOf(twice).code).toBe('grant_closed');
    const list = AuditRequestsResponseSchema.parse(
      (await get('/api/audit/requests', 'auditor')).json(),
    );
    expect(list.requests.map((r) => r.status)).toEqual(['ended']);
    expect((await activityTexts()).some((x) => x === 'Access for Auditor revoked')).toBe(true);
    expect(
      (await post(grantUrl('grant/audit-20260101-zzzzzz', 'revoke'), 'treasurer')).statusCode,
    ).toBe(404);
  });

  describe('a grant with a 2-second expiry', () => {
    let shortRequestId = '';
    let shortGrantId = '';

    it('is open while valid', async () => {
      const detail = await createRequest(
        'auditor',
        [{ recordId: 'outcome/2026-07/1', kind: 'outcome', reason: 'What was paid in July' }],
        'What did you pay in July?',
      );
      shortRequestId = detail.request.requestId;
      const res = await post(
        `/api/audit/requests/${shortRequestId}/grant`,
        'treasurer',
        { expiresIn: '24h' },
        short,
      );
      expect(res.statusCode, res.body).toBe(200);
      const grant = detailOf(res).request.grant;
      shortGrantId = grant?.grantId ?? '';
      expect(
        Date.parse(grant?.expiresAt ?? '') - Date.parse(grant?.grantedAt ?? ''),
      ).toBeLessThanOrEqual(2500);
      const open = await get(grantUrl(shortGrantId, 'evidence'), 'auditor');
      expect(open.statusCode, open.body).toBe(200);
      expect(EvidenceRoomSchema.parse(open.json()).records.map((r) => r.recordId)).toEqual([
        'outcome/2026-07/1',
      ]);
    });

    it('L9: after expiry the evidence route returns 410 even before the expiry job has run', async () => {
      await sleep(3000);
      const res = await get(grantUrl(shortGrantId, 'evidence'), 'auditor');
      expect(res.statusCode).toBe(410);
      expect(errorOf(res).code).toBe('access_ended');
      // The ledger still has the grant: nobody has closed it yet.
      expect(
        (await world.ledger.reader.grants()).some((g) => g.payload.grantId === shortGrantId),
      ).toBe(true);
      const view = detailOf(
        await get(`/api/audit/requests/${shortRequestId}`, 'treasurer'),
      ).request;
      expect(view.status).toBe('ended');
      expect(view.grant?.closedReason).toBe('expired');
    });

    it('A9, L9: the expiry job closes it, and the auditor view of the ledger is empty afterward', async () => {
      expiry = startGrantExpiry({
        ledger: world.ledger,
        activity: t.activity,
        bus: world.bus,
        names: t.names,
        readAs: [p().treasury],
        intervalMs: 3_600_000,
      });
      const run = await expiry.closeExpiredNow();
      expect(run.failed).toBe(0);
      expect(run.grants).toEqual([shortGrantId]);

      expect(await world.ledger.reader.as([p().auditor]).sharedRecords(p().auditor)).toEqual([]);
      const closed = await world.ledger.reader.closed();
      expect(closed.find((c) => c.payload.grantId === shortGrantId)?.payload.reason).toBe(
        'expired',
      );
      expect(
        (await world.ledger.reader.grants()).some((g) => g.payload.grantId === shortGrantId),
      ).toBe(false);
      expect((await get(grantUrl(shortGrantId, 'evidence'), 'auditor')).statusCode).toBe(410);

      const view = detailOf(await get(`/api/audit/requests/${shortRequestId}`, 'auditor')).request;
      expect(view).toMatchObject({
        status: 'ended',
        grant: { grantId: shortGrantId, closedReason: 'expired' },
      });
      expect(view.grant?.closedAt).not.toBeNull();
      expect(view.grant?.recordIds).toEqual(['outcome/2026-07/1']);
      expect(
        (await activityTexts()).some((x) =>
          /^Access for Auditor ended \d{4}-\d{2}-\d{2} \(expired\)$/.test(x),
        ),
      ).toBe(true);
    });
  });

  it('the treasurer denies a request: the auditor sees the reason and no records', async () => {
    const detail = await createRequest('auditor', [scopeItems[1]!], 'Why was September flagged?');
    const id = detail.request.requestId;
    expect(
      (await post(`/api/audit/requests/${id}/deny`, 'treasurer', { reason: '' })).statusCode,
    ).toBe(400);
    expect(
      (await post(`/api/audit/requests/${id}/deny`, 'auditor', { reason: 'no' })).statusCode,
    ).toBe(403);
    const res = await post(`/api/audit/requests/${id}/deny`, 'treasurer', {
      reason: 'Not for this audit',
    });
    expect(res.statusCode, res.body).toBe(200);
    const denied = detailOf(res).request;
    expect(denied.status).toBe('denied');
    expect(denied.denial).toMatchObject({ reason: 'Not for this audit' });
    expect(denied.scope.map((s) => s.recordId)).toEqual(['decision/2026-09/1']);

    const own = detailOf(await get(`/api/audit/requests/${id}`, 'auditor')).request;
    expect(own.status).toBe('denied');
    expect((await world.ledger.reader.denied()).map((d) => d.payload.requestId)).toContain(id);
    expect(await world.ledger.reader.as([p().auditor]).sharedRecords(p().auditor)).toEqual([]);
    expect((await get(grantUrl(grantIdOf(id), 'evidence'), 'auditor')).statusCode).toBe(404);
    expect(
      (await post(`/api/audit/requests/${id}/grant`, 'treasurer', { expiresIn: '7d' })).statusCode,
    ).toBe(409);
    expect((await activityTexts()).filter((x) => x === 'Request denied')).toHaveLength(1);
  });

  it('the auditor withdraws a pending request; a granted or answered one cannot be withdrawn', async () => {
    const detail = await createRequest('auditor', [scopeItems[0]!], 'Only July please');
    const id = detail.request.requestId;
    const res = await post(`/api/audit/requests/${id}/withdraw`, 'auditor');
    expect(res.statusCode, res.body).toBe(200);
    expect(detailOf(res).request.status).toBe('withdrawn');
    expect(await world.ledger.reader.auditRequests()).toEqual([]);
    expect((await world.ledger.reader.denied()).map((d) => d.payload.requestId)).not.toContain(id);

    const rows = await database.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.kind, 'audit.withdrawn'), eq(activityLog.subject, id)));
    expect(rows).toHaveLength(1);
    expect((await activityTexts()).some((x) => x === 'Auditor Auditor withdrew the request')).toBe(
      true,
    );

    // The treasurer still sees it in the list, as withdrawn, and cannot grant it.
    const list = AuditRequestsResponseSchema.parse(
      (await get('/api/audit/requests', 'treasurer')).json(),
    );
    expect(list.requests.find((r) => r.requestId === id)?.status).toBe('withdrawn');
    expect(
      (await post(`/api/audit/requests/${id}/grant`, 'treasurer', { expiresIn: '7d' })).statusCode,
    ).toBe(409);
    expect((await post(`/api/audit/requests/${id}/withdraw`, 'auditor')).statusCode).toBe(409);
    // A request that was granted cannot be withdrawn.
    expect((await post(`/api/audit/requests/${requestId}/withdraw`, 'auditor')).statusCode).toBe(
      409,
    );
    expect(
      (await post('/api/audit/requests/audit-20260101-nothing/withdraw', 'auditor')).statusCode,
    ).toBe(404);
  });

  it('the requests are listed newest first, for the treasurer all of them and for each auditor their own', async () => {
    const treasurer = AuditRequestsResponseSchema.parse(
      (await get('/api/audit/requests', 'treasurer')).json(),
    );
    expect(treasurer.requests.map((r) => r.status)).toEqual([
      'withdrawn',
      'denied',
      'ended',
      'ended',
    ]);
    const times = treasurer.requests.map((r) => r.requestedAt);
    expect([...times].sort().reverse()).toEqual(times);
    const outsider = AuditRequestsResponseSchema.parse(
      (await get('/api/audit/requests', 'outsider')).json(),
    );
    expect(outsider.requests).toEqual([]);
    // The second auditor can ask too, and then sees only their own request.
    const own = await createRequest('outsider', [scopeItems[0]!], 'July, from the other firm');
    const list = AuditRequestsResponseSchema.parse(
      (await get('/api/audit/requests', 'outsider')).json(),
    );
    expect(list.requests.map((r) => r.requestId)).toEqual([own.request.requestId]);
    expect(list.requests[0]?.auditor.displayName).toBe('Newcomer');
    expect((await get(`/api/audit/requests/${own.request.requestId}`, 'auditor')).statusCode).toBe(
      404,
    );
  });

  it('the treasurer reads request, scope, grant, view session and expiry in the activity log', async () => {
    const texts = await activityTexts();
    const has = (pattern: RegExp) => texts.some((x) => pattern.test(x));
    expect(has(/^Auditor Auditor requested access: Show all Q3 distributions/)).toBe(true);
    expect(has(/^Scope: 3 records proposed$/)).toBe(true);
    expect(has(/^Access granted to Auditor until .* \(2 records\)$/)).toBe(true);
    expect(has(/^Auditor Auditor opened the evidence room \(2 records\)$/)).toBe(true);
    expect(has(/^Access for Auditor ended .* \(expired\)$/)).toBe(true);
    expect(has(/^Access for Auditor revoked$/)).toBe(true);
    expect(has(/^Request denied$/)).toBe(true);
  });

  it('a signed-in party with no role can ask for access as a prospective auditor, and then sees only their own request', async () => {
    // No role yet: the lists are open (and empty), as is the first request.
    const before = await get('/api/audit/requests', 'prospect');
    expect(before.statusCode).toBe(200);
    expect(AuditRequestsResponseSchema.parse(before.json()).requests).toEqual([]);
    const created = await createRequest('prospect', [scopeItems[0]!], 'July, from a new firm');
    // The request makes them an auditor: they see their own request and no one else's.
    const list = AuditRequestsResponseSchema.parse(
      (await get('/api/audit/requests', 'prospect')).json(),
    );
    expect(list.requests.map((r) => r.requestId)).toEqual([created.request.requestId]);
    expect(list.requests[0]?.auditor.displayName).toBe('Prospect');
    expect((await get(`/api/audit/requests/${requestId}`, 'prospect')).statusCode).toBe(404);
    // Still no evidence without a grant, and no treasurer actions.
    expect(
      (await get(grantUrl(grantIdOf(created.request.requestId), 'evidence'), 'prospect'))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await post(`/api/audit/requests/${created.request.requestId}/grant`, 'prospect', {
          expiresIn: '7d',
        })
      ).statusCode,
    ).toBe(403);
    // The treasurer, approvers and holders are not prospects.
    const body = { question: QUESTION, items: [scopeItems[0]!], excluded: '' };
    for (const who of ['treasurer', 'approver1', 'holderA'] as const) {
      const denied = await post('/api/audit/requests', who, body);
      expect(denied.statusCode, who).toBe(403);
      expect(errorOf(denied).code).toBe('forbidden_role');
    }
  });

  it('MainNet: auditor and treasurer writes are signed in Grofty (409 sign_in_wallet); reads still work', async () => {
    const cookieOf = async (who: 'treasurer' | 'auditor') => ({
      cookie: (await mainnet.cookieFor(p()[who])).cookie,
    });
    const treasurer = await cookieOf('treasurer');
    const auditor = await cookieOf('auditor');
    const send = (url: string, headers: { cookie: string }, payload: unknown) =>
      mainnet.app.inject({ method: 'POST', url, headers, payload: payload as object });
    const responses = [
      await send('/api/audit/requests', auditor, {
        question: QUESTION,
        items: [{ recordId: 'decision/2026-09/1', kind: 'decision', reason: 'x' }],
        excluded: '',
      }),
      await send('/api/audit/requests/audit-20260101-nothing/withdraw', auditor, {}),
      await send('/api/audit/requests/audit-20260101-nothing/grant', treasurer, {
        expiresIn: '7d',
      }),
      await send('/api/audit/requests/audit-20260101-nothing/deny', treasurer, { reason: 'no' }),
      await send(grantUrl('grant/audit-20260101-nothing', 'revoke'), treasurer, {}),
    ];
    for (const res of responses) {
      expect(res.statusCode, res.body).toBe(409);
      expect(errorOf(res)).toEqual({ code: 'sign_in_wallet', message: SIGN_IN_WALLET_MESSAGE });
    }
    const list = await mainnet.app.inject({
      method: 'GET',
      url: '/api/audit/requests',
      headers: treasurer,
    });
    expect(list.statusCode).toBe(200);
  });
});
