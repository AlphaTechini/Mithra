import type { AddressInfo } from 'node:net';
import type { AgentConversation, SendAgentMessageResponse } from '@mithra/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActivityLog } from '../../src/activity/log';
import { createAgent } from '../../src/agent/agent';
import { createFakeServices, type FakeServices } from '../../src/agent/fakes';
import { createPolicyDrafter } from '../../src/agent/policyDrafter';
import { createAgentStore } from '../../src/agent/store';
import { buildApp } from '../../src/app';
import { createScopeDrafter } from '../../src/audit/scope';
import { startGrantExpiry } from '../../src/audit/expiry';
import { createDatabase, runMigrations, type DatabaseHandle } from '../../src/db';
import { activityLog, chatMessages, cycleRuns } from '../../src/db/schema';
import { EventBus, type Published } from '../../src/events/bus';
import { LedgerError, choiceResults, createdIn } from '../../src/ledger';
import { createLlm } from '../../src/llm/client';
import { PartyNames } from '../../src/parties/names';
import { agentRoutes } from '../../src/routes/agent';
import { eventsRoute } from '../../src/routes/events';
import { startScheduler } from '../../src/scheduler';
import { createScheduleStore } from '../../src/scheduler/store';
import { startLlmStub, type LlmStub } from '../llm-stub/server';
import { createWorld, proposalInput, requireSandbox, submitter, type World } from './helpers';

const DATABASE_URL =
  process.env['DATABASE_URL_TEST'] ?? 'postgres://mithra:mithra@localhost:5432/mithra_test_m5';

function cookieOf(res: LightMyRequestResponse): string {
  const header = res.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  return (value ?? '').split(';')[0] ?? '';
}

async function until(check: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${ms} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('agent, grant expiry, scheduler and live events against a Canton sandbox and PostgreSQL', () => {
  let world: World;
  let as: ReturnType<typeof submitter>;
  let database: DatabaseHandle;
  let bus: EventBus;
  let published: Published[];
  let names: PartyNames;
  let activity: ActivityLog;
  let stub: LlmStub;
  let services: FakeServices;
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    await requireSandbox();
    world = await createWorld();
    as = submitter(world.ledger);
    database = createDatabase(DATABASE_URL);
    await runMigrations(database.db);
    bus = new EventBus();
    published = [];
    bus.subscribe((p) => published.push(p));
    names = new PartyNames(world.config, database.db, 0);
    activity = new ActivityLog(database.db, bus, names);
    stub = await startLlmStub();
    services = createFakeServices();

    const llm = createLlm({
      baseUrl: stub.baseUrl,
      apiKey: 'test',
      model: 'test-model',
      timeoutMs: 5000,
      maxRetries: 0,
    });
    const store = createAgentStore(database.db);
    const scope = createScopeDrafter({ llm, catalog: () => Promise.resolve([]) });
    const agent = createAgent({
      llm,
      services,
      names,
      bus,
      db: database.db,
      activity,
      scope,
      proposalWaitMs: 500,
      pollMs: 10,
    });
    const drafter = createPolicyDrafter({ llm, services, store });

    app = buildApp(world.config, { database, ledger: world.ledger });
    // The agent and event routes join the app after the session plugin, as app.ts will register them.
    void app.register((scoped, _options, done) => {
      agentRoutes(scoped, { agent, drafter, scope });
      eventsRoute(scoped, { bus });
      done();
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
    await stub?.close();
  });

  async function signIn(partyId: string): Promise<string> {
    const signedIn = await app.inject({
      method: 'POST',
      url: '/api/session/localnet/sign-in',
      payload: { password: 'demo-password' },
    });
    const cookie = cookieOf(signedIn);
    const switched = await app.inject({
      method: 'POST',
      url: '/api/session/switch',
      headers: { cookie },
      payload: { partyId },
    });
    expect(switched.statusCode).toBe(200);
    return cookie;
  }

  it('A9: closes a real AccessGrant within seconds of its 2-second expiry; the auditor then sees no SharedRecord', async () => {
    const { parties, ids, ledger } = world;
    const proposeTx = await as.as(
      [parties.agent],
      [
        ledger.commands.mandatePropose(
          ids.mandateCid,
          proposalInput(world, { cycleId: '2026-09', total: '1200' }),
        ),
      ],
      { readAs: [parties.treasury] },
    );
    world.ids.mandateCid = choiceResults.mandatePropose(proposeTx).mandateCid;
    const decision = (await ledger.reader.decisionRecords()).find(
      (d) => d.payload.cycleId === '2026-09',
    );
    expect(decision).toBeTruthy();

    const requestTx = await as.as(
      [parties.auditor],
      [
        ledger.commands.createAuditRequest({
          auditor: parties.auditor,
          treasury: parties.treasury,
          treasurer: parties.treasurer,
          agent: parties.agent,
          requestId: 'req-expiry',
          question: 'How was September prepared?',
          scope: [
            {
              recordId: decision?.payload.recordId ?? '',
              kind: 'decision',
              reason: 'Inputs and checks',
            },
          ],
          excluded: 'Holder identities',
          requestedAt: new Date(),
        }),
      ],
    );
    const requestCid = createdIn(requestTx, 'Mithra.Audit:AuditRequest')[0]?.contractId ?? '';
    const expiresAt = new Date(Date.now() + 2000);
    await as.as(
      [parties.treasurer],
      [
        ledger.commands.orgGrantAccess(ids.orgCid, {
          requestCid,
          expiresAt,
          evidence: [{ tag: 'RefDecision', value: decision?.contractId ?? '' }],
        }),
      ],
      { readAs: [parties.agent] },
    );
    const asAuditor = ledger.reader.as([parties.auditor]);
    // The grant is live: one shared record.
    expect(await asAuditor.sharedRecords(parties.auditor)).toHaveLength(1);
    expect(await ledger.reader.grants()).toHaveLength(1);

    const expiry = startGrantExpiry({
      ledger,
      activity,
      bus,
      names,
      intervalMs: 500,
      readAs: [parties.treasury],
    });
    try {
      await until(
        async () => (await asAuditor.sharedRecords(parties.auditor)).length === 0,
        20_000,
        'the auditor to lose the shared record',
      );
    } finally {
      expiry.stop();
    }
    const closedAfter = Date.now() - expiresAt.getTime();
    // Far inside the 5-minute requirement (the job runs every 500 ms in this test).
    expect(closedAfter).toBeLessThan(15_000);

    expect(await asAuditor.sharedRecords(parties.auditor)).toEqual([]);
    expect(await ledger.reader.grants()).toEqual([]);
    expect((await ledger.reader.closed())[0]?.payload).toMatchObject({
      reason: 'expired',
      closedBy: parties.agent,
      requestId: 'req-expiry',
    });

    const rows = await database.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.kind, 'grant.closed'));
    // The table persists between runs: pick this run's row by its (unique) agent party.
    const row = rows.find(
      (r) =>
        r.actorParty === parties.agent &&
        (r.detail as { requestId?: string }).requestId === 'req-expiry',
    );
    expect(row?.actorParty).toBe(parties.agent);
    expect((row?.detail as { text: string }).text).toMatch(
      /^Access for .+ ended \d{4}-\d{2}-\d{2} \(expired\)$/,
    );
    expect(
      published.some(
        (p) =>
          p.event.type === 'audit' &&
          p.event.requestId === 'req-expiry' &&
          p.audience.parties?.includes(parties.treasurer) &&
          p.audience.parties.includes(parties.auditor),
      ),
    ).toBe(true);
  });

  it('A7: the agent party has no ledger right to approve, seal, grant, deny, revoke or execute without approvals', async () => {
    const { parties, ids, ledger } = world;
    const { commands } = ledger;
    const input = proposalInput(world, { cycleId: '2026-08', total: '6000' });
    const proposeTx = await as.as(
      [parties.agent],
      [commands.mandatePropose(ids.mandateCid, input)],
      {
        readAs: [parties.treasury],
      },
    );
    const { proposalCid, mandateCid } = choiceResults.mandatePropose(proposeTx);
    world.ids.mandateCid = mandateCid;
    const asAgent = (
      command: Parameters<typeof as.as>[1][number],
      readAs: string[] = [parties.treasury],
    ) => as.as([parties.agent], [command], { readAs });

    // Approve a proposal: as itself (not an approver) and as an approver (no right to act as one).
    await expect(
      asAgent(commands.proposalApprove(proposalCid, { approver: parties.agent, note: 'x' })),
    ).rejects.toBeInstanceOf(LedgerError);
    await expect(
      asAgent(commands.proposalApprove(proposalCid, { approver: parties.approver1, note: 'x' })),
    ).rejects.toBeInstanceOf(LedgerError);
    await expect(
      asAgent(commands.proposalReject(proposalCid, { approver: parties.approver1, reason: 'x' })),
    ).rejects.toBeInstanceOf(LedgerError);

    // Execute a proposal that needs approvals, with none given.
    await expect(
      asAgent(
        commands.mandateAgentExecute(ids.mandateCid, {
          proposalCid,
          legs: input.payouts.map((p) => ({
            holder: p.holder,
            factoryCid: ids.factoryCid,
            extraArgs: { context: { values: {} }, meta: { values: {} } },
          })),
          inputHoldingCids: [],
          executeBefore: new Date(Date.now() + 60_000),
        }),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('needs 2 approval') as string });

    // Seal a Mandate: the treasurer signs a request, but only the treasury applies it.
    const sealTx = await as.as(
      [parties.treasurer],
      [
        commands.createMandateSealRequest({
          treasury: parties.treasury,
          treasurer: parties.treasurer,
          agent: parties.agent,
          terms: { ...world.terms, cap: '9999.0000000000' },
          agentExecutes: true,
          summary: 'Raise the cap',
          summaryFingerprint: '00',
          requestedAt: new Date(),
        }),
      ],
    );
    const sealRequestCid =
      createdIn(sealTx, 'Mithra.Mandate:MandateSealRequest')[0]?.contractId ?? '';
    const mandate = await ledger.reader.mandate();
    await expect(
      asAgent(
        commands.orgApplySeal(ids.orgCid, {
          sealRequestCid,
          currentMandateCid: mandate?.contractId ?? null,
        }),
      ),
    ).rejects.toBeInstanceOf(LedgerError);
    expect((await ledger.reader.mandate())?.payload.terms.cap).toMatch(/^5000(\.0+)?$/);

    // Grant, deny or revoke audit access: only the treasurer controls these.
    const decision = (await ledger.reader.decisionRecords())[0];
    const requestTx = await as.as(
      [parties.auditor],
      [
        commands.createAuditRequest({
          auditor: parties.auditor,
          treasury: parties.treasury,
          treasurer: parties.treasurer,
          agent: parties.agent,
          requestId: 'req-a7',
          question: 'q',
          scope: [{ recordId: decision?.payload.recordId ?? '', kind: 'decision', reason: 'r' }],
          excluded: '',
          requestedAt: new Date(),
        }),
      ],
    );
    const requestCid = createdIn(requestTx, 'Mithra.Audit:AuditRequest')[0]?.contractId ?? '';
    await expect(
      asAgent(
        commands.orgGrantAccess(ids.orgCid, {
          requestCid,
          expiresAt: new Date(Date.now() + 3_600_000),
          evidence: [{ tag: 'RefDecision', value: decision?.contractId ?? '' }],
        }),
        [parties.treasury, parties.treasurer],
      ),
    ).rejects.toBeInstanceOf(LedgerError);
    await expect(
      asAgent(commands.orgDenyAccess(ids.orgCid, { requestCid, reason: 'no' })),
    ).rejects.toBeInstanceOf(LedgerError);
    expect(await ledger.reader.grants()).toEqual([]);
    expect(await ledger.reader.denied()).toEqual([]);
  });

  it('the scheduler fires once per cycle against the real cycle_runs table, also after a restart', async () => {
    const { parties } = world;
    const treasury = parties.treasury;
    const runs = createFakeServices();
    // Like the cycle engine: claim the cycle_runs row (unique per treasury and cycle), then proceed.
    runs.cycles.run = async (input) => {
      const cycleId = input.cycleId ?? 'unknown';
      await database.db
        .insert(cycleRuns)
        .values({ orgTreasury: treasury, cycleId, status: 'running' });
      runs.runs.push(input);
      return { cycleId };
    };
    const start = () =>
      startScheduler({
        services: runs,
        ledger: world.ledger,
        db: database.db,
        bus,
        treasuryParty: treasury,
        agentParty: parties.agent,
        activity,
        now: () => new Date('2026-11-01T09:00:00Z'),
      });
    runs.state.mandate = {
      ...runs.state.mandate!,
      terms: { ...runs.state.mandate!.terms, fixedAmount: '1200' },
    };

    const first = start();
    await first.ready;
    const results = await Promise.all([first.fireNow(), first.fireNow()]);
    expect(results.map((r) => r.outcome)).toEqual(['started', 'started']);
    expect((await first.fireNow()).outcome).toBe('already-ran');
    first.stop();

    const second = start();
    await second.ready;
    expect((await second.fireNow()).outcome).toBe('already-ran');
    second.stop();
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]).toMatchObject({ trigger: 'schedule', cycleId: '2026-10', total: '1200' });
    const rows = await database.db
      .select()
      .from(cycleRuns)
      .where(eq(cycleRuns.orgTreasury, treasury));
    expect(rows.map((r) => r.cycleId)).toEqual(['2026-10']);

    // Even if the scheduler's own check said "not yet", the engine's unique key refuses a second run.
    const blind = startScheduler({
      services: runs,
      ledger: world.ledger,
      store: { ...createScheduleStore(database.db), hasRun: () => Promise.resolve(false) },
      bus,
      treasuryParty: treasury,
      agentParty: parties.agent,
      now: () => new Date('2026-11-01T09:00:00Z'),
    });
    await blind.ready;
    expect((await blind.fireNow()).outcome).toBe('already-ran');
    blind.stop();
  });

  it('chat over HTTP: roles come from the ledger, replies are stored, and cards reach the live stream', async () => {
    const { parties } = world;
    const treasurer = await signIn(parties.treasurer);
    const approver = await signIn(parties.approver1);
    const holder = await signIn(parties.holderA);

    // Holders cannot use the agent; approvers and the treasurer can.
    expect(
      (await app.inject({ method: 'GET', url: '/api/agent/messages', headers: { cookie: holder } }))
        .statusCode,
    ).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/agent/messages' })).statusCode).toBe(401);
    expect((await fetch(`${baseUrl}/api/events`)).status).toBe(401);

    // The treasurer's live stream.
    const controller = new AbortController();
    const stream = await fetch(`${baseUrl}/api/events`, {
      headers: { cookie: treasurer },
      signal: controller.signal,
    });
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    let streamed = '';
    const reader = stream.body?.getReader();
    void (async () => {
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const chunk = await reader?.read();
          if (!chunk || chunk.done) return;
          streamed += decoder.decode(chunk.value as Uint8Array);
        }
      } catch {
        // aborted
      }
    })();

    stub.script(
      { toolCalls: [{ name: 'get_balance', arguments: {} }] },
      { text: 'The treasury holds 25,000 CC.' },
    );
    const sent = await app.inject({
      method: 'POST',
      url: '/api/agent/messages',
      headers: { cookie: treasurer },
      payload: { text: 'How much is in the treasury?' },
    });
    expect(sent.statusCode).toBe(200);
    const body = sent.json<SendAgentMessageResponse>();
    expect(body.reply.text).toBe('The treasury holds 25,000 CC.');
    expect(body.reply.actions[0]).toMatchObject({
      tool: 'get_balance',
      title: 'Treasury balance: 25,000 CC',
    });

    await until(
      () => Promise.resolve(streamed.includes('event: agent')),
      5000,
      'the agent event on the stream',
    );
    expect(streamed).toContain('"type":"agent"');
    expect(streamed).toContain('Treasury balance: 25,000 CC');
    controller.abort();

    // The conversation is stored per party in PostgreSQL.
    const conversation = (
      await app.inject({
        method: 'GET',
        url: '/api/agent/messages',
        headers: { cookie: treasurer },
      })
    ).json<AgentConversation>();
    expect(conversation.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(conversation.suggestions).toContain('Distribute 1,200 CC for September.');
    const stored = await database.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.partyId, parties.treasurer));
    expect(stored).toHaveLength(2);
    // The approver has their own, empty conversation and read-only tools.
    const approverView = (
      await app.inject({ method: 'GET', url: '/api/agent/messages', headers: { cookie: approver } })
    ).json<AgentConversation>();
    expect(approverView.messages).toEqual([]);
    stub.script({ text: 'ok' });
    await app.inject({
      method: 'POST',
      url: '/api/agent/messages',
      headers: { cookie: approver },
      payload: { text: 'hello' },
    });
    expect(
      stub.requests
        .at(-1)
        ?.tools?.map((t) => t.function.name)
        .sort(),
    ).toEqual(['explain_proposal', 'get_balance', 'list_holders', 'query_history']);
  });

  it('A11 over HTTP: with the model endpoint down the reply is degraded and nothing was executed', async () => {
    const { parties } = world;
    const treasurer = await signIn(parties.treasurer);
    const before = services.writes().length;
    stub.always({ status: 500 });
    const sent = await app.inject({
      method: 'POST',
      url: '/api/agent/messages',
      headers: { cookie: treasurer },
      payload: { text: 'Distribute 1,200 CC for September.' },
    });
    expect(sent.statusCode).toBe(200);
    const body = sent.json<SendAgentMessageResponse>();
    expect(body.reply.degraded).toBe(true);
    expect(body.reply.text).toBe(
      "I can't reach the language model right now (500 from the model provider). Nothing was executed. You can still use Run cycle now and the screens.",
    );
    expect(services.writes()).toHaveLength(before);

    const draft = await app.inject({
      method: 'POST',
      url: '/api/policy/draft',
      headers: { cookie: treasurer },
      payload: { prompt: 'Pay monthly yield on the 1st.' },
    });
    expect(draft.statusCode).toBe(503);
    expect(draft.json()).toEqual({
      error: {
        code: 'llm_unavailable',
        message:
          "The agent can't draft right now (500 from the model provider). Fill in the policy form yourself; nothing was changed.",
      },
    });
  });
});
