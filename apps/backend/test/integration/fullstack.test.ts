import {
  ActivityResponseSchema,
  ApprovalsInboxSchema,
  CycleDetailSchema,
  CyclesResponseSchema,
  HolderPositionSchema,
  HoldersResponseSchema,
  MandateViewSchema,
  OrgResponseSchema,
  OverviewResponseSchema,
  PolicyDraftSchema,
  SealStatusSchema,
  SendAgentMessageResponseSchema,
  SessionResponseSchema,
  TxDetailSchema,
  toDecimal,
  type CycleDetail,
  type LiveEvent,
} from '@mithra/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootFullStack, DEMO_PASSWORD, type FullStack } from '../e2e/server';
import { daysAgo, isoDate, requireSandbox } from './helpers';

/**
 * The happy path of userflow section 0 (without the audit part) over HTTP, against the real
 * application: sessions, organization, the agent drafting the policy from the demo prompt, sealing,
 * units, a clean cycle prompted through the agent (countdown, auto-pay, a holder accepting), a
 * flagged cycle (two approvals), holder isolation, the overview, the activity log and live events.
 */

const DATABASE_URL =
  process.env['DATABASE_URL_TEST_MW'] ?? 'postgres://mithra:mithra@localhost:5432/mithra_test_mw';

const DEMO_PROMPT =
  'Pay monthly yield on the 1st. Auto-pay if the total is under 5,000 CC and nothing looks off. Otherwise 2 of 3 approvals.';

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** The month `back` months before this one, as `{ id: '2026-08', name: 'August', lastDay: '2026-08-31' }`. */
function monthBefore(back: number): { id: string; name: string; lastDay: string } {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  return {
    id: `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, '0')}`,
    name: MONTH_NAMES[first.getUTCMonth()] ?? '',
    lastDay: isoDate(last),
  };
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

interface Reply<T = unknown> {
  status: number;
  body: string;
  json(): T;
}

/** A cookie-keeping HTTP client for one signed-in party. */
class Client {
  private cookie = '';

  constructor(private readonly base: string) {}

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<Reply<T>> {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const set = response.headers.getSetCookie()[0];
    if (set) this.cookie = set.split(';')[0] ?? '';
    const text = await response.text();
    return { status: response.status, body: text, json: () => JSON.parse(text) as T };
  }

  get cookieHeader(): string {
    return this.cookie;
  }

  get<T = unknown>(path: string): Promise<Reply<T>> {
    return this.request<T>('GET', path);
  }

  post<T = unknown>(path: string, body?: unknown): Promise<Reply<T>> {
    return this.request<T>('POST', path, body ?? {});
  }

  put<T = unknown>(path: string, body: unknown): Promise<Reply<T>> {
    return this.request<T>('PUT', path, body);
  }
}

async function eventually<T>(
  check: () => Promise<T | undefined | false>,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const result = await check();
    if (result !== undefined && result !== false) return result;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe('full stack: the happy path over HTTP (sessions to paid cycles)', () => {
  let stack: FullStack;
  let base: string;
  const clients: Record<string, Client> = {};
  const abort = new AbortController();
  const live: LiveEvent[] = [];

  const clean = monthBefore(2);
  const flagged = monthBefore(1);

  async function signIn(name: string, partyId: string): Promise<Client> {
    const client = new Client(base);
    const signedIn = await client.post('/api/session/localnet/sign-in', {
      password: DEMO_PASSWORD,
    });
    expect(signedIn.status).toBe(200);
    const switched = await client.post('/api/session/switch', { partyId });
    expect(switched.status).toBe(200);
    clients[name] = client;
    return client;
  }

  const as = (name: string): Client => {
    const client = clients[name];
    if (!client) throw new Error(`${name} is not signed in`);
    return client;
  };

  async function cycleDetail(who: string, cycleId: string): Promise<CycleDetail> {
    const reply = await as(who).get(`/api/cycles/${cycleId}`);
    expect(reply.status).toBe(200);
    return CycleDetailSchema.parse(reply.json());
  }

  async function waitForStatus(who: string, cycleId: string, status: string): Promise<CycleDetail> {
    return eventually(async () => {
      const detail = await cycleDetail(who, cycleId).catch(() => undefined);
      return detail?.summary.status === status ? detail : undefined;
    }, `${cycleId} to be ${status}`);
  }

  async function positionOf(who: string) {
    const reply = await as(who).get('/api/me/position');
    expect(reply.status).toBe(200);
    return HolderPositionSchema.parse(reply.json());
  }

  beforeAll(async () => {
    await requireSandbox();
    stack = await bootFullStack({
      databaseUrl: DATABASE_URL,
      holdCountdownSeconds: 2,
      reconcileIntervalMs: 500,
      webDistDir: null,
      logLevel: 'silent',
    });
    base = await stack.listen(0);
    const { parties } = stack;
    for (const [name, partyId] of Object.entries({
      treasurer: parties.treasurer,
      approver1: parties.approver1,
      approver2: parties.approver2,
      approver3: parties.approver3,
      holderA: parties.holderA,
      holderB: parties.holderB,
      holderC: parties.holderC,
      holderD: parties.holderD,
    })) {
      await signIn(name, partyId);
    }
  });

  afterAll(async () => {
    abort.abort();
    await stack?.close();
  });

  it('serves health, status and a JSON 404 for unknown API routes; the session needs a password', async () => {
    const anonymous = new Client(base);
    expect((await anonymous.get('/api/health')).status).toBe(200);
    const status = (
      await anonymous.get<{ ledger: { ok: boolean }; database: { ok: boolean } }>('/api/status')
    ).json();
    expect(status.ledger.ok).toBe(true);
    expect(status.database.ok).toBe(true);
    expect((await anonymous.get('/api/nothing-here')).status).toBe(404);
    expect(
      (await anonymous.post('/api/session/localnet/sign-in', { password: 'wrong' })).status,
    ).toBe(401);
    // Signed out: the product's routes ask to sign in.
    expect((await anonymous.get('/api/overview')).status).toBe(401);
    expect((await anonymous.get('/api/events')).status).toBe(401);
  });

  it('starts as a party with no role, then the treasurer creates the organization', async () => {
    const treasurer = as('treasurer');
    const session = SessionResponseSchema.parse((await treasurer.get('/api/session')).json());
    expect(session.party).toMatchObject({ displayName: 'Treasurer', roles: [], primaryRole: null });
    const before = OrgResponseSchema.parse((await treasurer.get('/api/org')).json());
    expect(before.setupStep).toBe('organization');

    const { parties } = stack;
    const created = await treasurer.post('/api/org', {
      name: 'Northwind Income Fund',
      approvers: [parties.approver1, parties.approver2, parties.approver3],
      approvalThreshold: 2,
    });
    expect(created.status).toBe(201);
    const org = OrgResponseSchema.parse(created.json());
    expect(org.setupStep).toBe('policy');
    expect(org.organization?.approvers.map((a) => a.displayName)).toEqual([
      'Approver 1',
      'Approver 2',
      'Approver 3',
    ]);
    expect(
      (
        await treasurer.post('/api/org', {
          name: 'Again',
          approvers: [parties.approver1],
          approvalThreshold: 1,
        })
      ).status,
    ).toBe(409);

    // Live updates: the treasurer's stream (opened once the role exists) stays open for the whole run.
    const events = await fetch(`${base}/api/events`, {
      headers: { cookie: treasurer.cookieHeader },
      signal: abort.signal,
    });
    expect(events.status).toBe(200);
    void (async () => {
      // The Node fetch body is a web stream of bytes; the project's lib has no DOM types for it.
      const reader = events.body?.getReader() as
        ReadableStreamDefaultReader<Uint8Array> | undefined;
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = block
              .split('\n')
              .find((line) => line.startsWith('data: '))
              ?.slice(6);
            if (data) live.push(JSON.parse(data) as LiveEvent);
          }
        }
      } catch {
        // The test closes the stream at the end.
      }
    })();

    const roles = SessionResponseSchema.parse((await treasurer.get('/api/session')).json());
    expect(roles.party?.roles).toEqual(['treasurer']);
    expect(
      SessionResponseSchema.parse((await as('approver1').get('/api/session')).json()).party?.roles,
    ).toEqual(['approver']);
  });

  it('drafts the policy from the demo prompt with the organization approvers, then seals it', async () => {
    const treasurer = as('treasurer');
    const { parties } = stack;
    const drafted = await treasurer.post('/api/policy/draft', { prompt: DEMO_PROMPT });
    expect(drafted.status).toBe(200);
    const draft = PolicyDraftSchema.parse(drafted.json());
    expect(draft.source).toBe('agent');
    expect(draft.fields).toMatchObject({
      cap: '5000',
      approvalThreshold: 2,
      approvers: [parties.approver1, parties.approver2, parties.approver3],
      scheduleCron: '0 9 1 * *',
      scheduleTimezone: 'UTC',
      recordDateRule: 'last_day_of_previous_month',
      fixedAmount: null,
      deviationPct: '50',
      trailingCycles: 3,
      unitChangePct: '100',
      unitChangeWindowDays: 3,
      feeBuffer: '1',
    });
    expect(draft.agentCannot.length).toBeGreaterThan(0);
    const fetched = PolicyDraftSchema.parse((await treasurer.get('/api/policy/draft')).json());
    expect(fetched.draftId).toBe(draft.draftId);

    const sealing = await treasurer.post('/api/mandate/seal', { draftId: draft.draftId });
    expect(sealing.status).toBe(200);
    const seal = SealStatusSchema.parse(sealing.json());
    expect(seal.state).toBe('sealed');
    const mandate = MandateViewSchema.parse((await treasurer.get('/api/mandate')).json());
    expect(mandate).toMatchObject({ version: 1, agentExecutes: true });
    expect(mandate.terms).toMatchObject({ approvalThreshold: 2, cap: '5000.0000000000' });
    expect(OrgResponseSchema.parse((await treasurer.get('/api/org')).json()).setupStep).toBe(
      'done',
    );
  });

  it('issues units, shows the holders table, and a holder accepts their units', async () => {
    const treasurer = as('treasurer');
    const { parties } = stack;
    const effectiveDate = isoDate(daysAgo(150));
    for (const [holder, units] of [
      [parties.holderA, 100],
      [parties.holderB, 300],
      [parties.holderC, 600],
      [parties.holderD, 1000],
    ] as const) {
      const issued = await treasurer.post('/api/holders/issue', { holder, units, effectiveDate });
      expect(issued.status).toBe(200);
    }
    const table = HoldersResponseSchema.parse((await treasurer.get('/api/holders')).json());
    expect(table.totalUnits).toBe(2000);
    // Largest holding first; D has no auto-receive, so its payments wait for acceptance.
    expect(table.holders.map((h) => [h.holder.displayName, h.units, h.autoReceive])).toEqual([
      ['Holder D', 1000, false],
      ['Holder C', 600, true],
      ['Holder B', 300, true],
      ['Holder A', 100, true],
    ]);

    const before = await positionOf('holderA');
    expect(before).toMatchObject({ units: 100, orgName: 'Northwind Income Fund', payments: [] });
    expect(before.pendingUnits).toHaveLength(1);
    const accepted = await as('holderA').post(
      `/api/me/units/${before.pendingUnits[0]?.unitId ?? ''}/accept`,
    );
    expect(accepted.status).toBe(200);
    expect(HolderPositionSchema.parse(accepted.json()).pendingUnits).toEqual([]);
  });

  it('a clean cycle asked of the agent: all checks pass, the countdown runs, holders are paid, D accepts', async () => {
    const treasurer = as('treasurer');
    const asked = await treasurer.post('/api/agent/messages', {
      text: `Distribute 300 CC for ${clean.name}`,
    });
    expect(asked.status).toBe(200);
    const reply = SendAgentMessageResponseSchema.parse(asked.json()).reply;
    expect(reply.actions[0]).toMatchObject({
      tool: 'create_cycle',
      status: 'done',
      link: `/app/cycles/${clean.id}`,
    });

    const countdown = await cycleDetail('treasurer', clean.id);
    expect(['countdown', 'executing', 'awaiting-acceptance']).toContain(countdown.summary.status);
    expect(countdown.summary).toMatchObject({ trigger: 'prompt', total: '300.0000000000' });
    expect(countdown.proposal?.verdict).toBe('within-mandate');
    expect(countdown.proposal?.checks.filter((c) => c.source === 'deterministic')).toHaveLength(7);
    expect(countdown.proposal?.checks.every((c) => c.passed)).toBe(true);
    expect(countdown.proposal?.memoSource).toBe('ai');
    expect(countdown.proposal?.memo).toContain('All checks passed');
    // The amounts are the pro-rata split of 300 over 2000 units, computed by code.
    expect(
      countdown.proposal?.payouts.map((p) => [p.holder.displayName, p.units, p.amount]),
    ).toEqual([
      ['Holder A', 100, '15.0000000000'],
      ['Holder B', 300, '45.0000000000'],
      ['Holder C', 600, '90.0000000000'],
      ['Holder D', 1000, '150.0000000000'],
    ]);

    // After the countdown the agent pays: A to C are paid at once, D has to accept.
    const executed = await waitForStatus('treasurer', clean.id, 'awaiting-acceptance');
    expect(executed.timeline.map((s) => s.id)).toEqual([
      'woke',
      'snapshot',
      'amounts',
      'checks',
      'review',
      'verdict',
      'execute',
    ]);
    expect(
      executed.proposal?.payouts.map((p) => [p.holder.displayName, p.payment?.status]),
    ).toEqual([
      ['Holder A', 'paid'],
      ['Holder B', 'paid'],
      ['Holder C', 'paid'],
      ['Holder D', 'awaiting-acceptance'],
    ]);

    const waiting = await positionOf('holderD');
    expect(waiting.payments).toHaveLength(1);
    expect(waiting.payments[0]).toMatchObject({
      status: 'awaiting-acceptance',
      amount: '150.0000000000',
    });
    const accepted = await as('holderD').post(
      `/api/me/payments/${waiting.payments[0]?.paymentId ?? ''}/accept`,
    );
    expect(accepted.status).toBe(200);
    // The accept route marks the Payment Paid right away; it does not wait for the next pass.
    const paid = HolderPositionSchema.parse(accepted.json());
    expect(paid.payments[0]?.status).toBe('paid');
    expect(paid.totalReceived).toBe('150.0000000000');
    // The recreated Payment has its own link: the transaction that accepted the transfer.
    const link = paid.payments[0]?.link;
    expect(link?.href).toBe(`/holder/tx/${link?.updateId}`);
    const tx = TxDetailSchema.parse((await as('holderD').get(`/api/tx/${link?.updateId}`)).json());
    expect(tx.payments.every((p) => p.holder.displayName === 'Holder D')).toBe(true);

    const done = await waitForStatus('treasurer', clean.id, 'paid-automatically');
    expect(done.proposal?.payouts.every((p) => p.payment?.status === 'paid')).toBe(true);
  });

  it('a flagged cycle needs 2 of 3 approvals and is paid after Approver 1 and Approver 2 approve', async () => {
    const treasurer = as('treasurer');
    const { parties } = stack;
    // Holder C's units jump inside the 3-day window before the record date.
    const jumped = await treasurer.post('/api/holders/issue', {
      holder: parties.holderC,
      units: 900,
      effectiveDate: addDays(flagged.lastDay, -1),
    });
    expect(jumped.status).toBe(200);

    const run = await treasurer.post('/api/cycles/run', { cycleId: flagged.id, total: '1200' });
    expect(run.status).toBe(202);
    const proposed = await waitForStatus('treasurer', flagged.id, 'awaiting-approval');
    const proposal = proposed.proposal;
    expect(proposal?.verdict).toBe('needs-approval');
    const failed = proposal?.checks.filter((c) => !c.passed && c.source === 'deterministic') ?? [];
    expect(failed.map((c) => c.code).sort()).toEqual(['deviation', 'unit_spike']);
    expect(failed.find((c) => c.code === 'deviation')?.actual).toContain('1,200');
    expect(failed.find((c) => c.code === 'unit_spike')?.actual).toContain('Holder C');
    // The model's review adds one advisory flag, which blocks nothing and clears nothing.
    const advisory = proposal?.checks.filter((c) => c.source === 'ai') ?? [];
    expect(advisory).toHaveLength(1);
    expect(advisory[0]).toMatchObject({ blocking: false, passed: false });
    expect(proposal?.memoSource).toBe('ai');
    expect(proposed.summary.approvals).toEqual({ have: 0, need: 2 });
    expect(proposed.summary.flagCount).toBeGreaterThanOrEqual(2);

    // The approver sees it in the inbox; the treasurer and holders do not get the inbox.
    expect((await as('treasurer').get('/api/approvals')).status).toBe(403);
    const inbox = ApprovalsInboxSchema.parse((await as('approver1').get('/api/approvals')).json());
    expect(inbox.pending.map((p) => [p.cycleId, p.youApproved])).toEqual([[flagged.id, false]]);
    // The proposal id has slashes ("proposal/2026-09/1"), so clients encode it in the path.
    const proposalId = encodeURIComponent(proposal?.proposalId ?? '');

    // Nobody pays it before the threshold: a wait of two reconciler passes changes nothing.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect((await cycleDetail('treasurer', flagged.id)).summary.status).toBe('awaiting-approval');

    const first = await as('approver1').post(`/api/proposals/${proposalId}/approve`, {
      note: 'Holder C bought more units, confirmed with them.',
    });
    expect(first.status).toBe(200);
    expect(CycleDetailSchema.parse(first.json()).summary.approvals).toEqual({ have: 1, need: 2 });
    expect((await cycleDetail('treasurer', flagged.id)).summary.status).toBe('awaiting-approval');
    // A second approval by the same approver is refused.
    expect(
      (await as('approver1').post(`/api/proposals/${proposalId}/approve`, {})).status,
    ).toBeGreaterThanOrEqual(400);

    const second = await as('approver2').post(`/api/proposals/${proposalId}/approve`, {
      note: 'ok',
    });
    expect(second.status).toBe(200);
    // Executed: D's payment waits for acceptance again, then the cycle is paid after approval.
    await waitForStatus('treasurer', flagged.id, 'awaiting-acceptance');
    const waiting = (await positionOf('holderD')).payments.find(
      (p) => p.status === 'awaiting-acceptance',
    );
    expect(waiting?.cycleLabel).toContain(flagged.name);
    const accepted = await as('holderD').post(
      `/api/me/payments/${waiting?.paymentId ?? ''}/accept`,
    );
    expect(accepted.status).toBe(200);
    const finished = await waitForStatus('treasurer', flagged.id, 'paid-after-approval');
    expect(finished.summary.approvals).toEqual({ have: 2, need: 2 });
    expect(finished.proposal?.approvals.map((a) => a.approver.displayName)).toEqual([
      'Approver 1',
      'Approver 2',
    ]);
    // C holds 1500 of 2900 units on the record date: 1200 x 1500 / 2900 and so on, summing to the total.
    const sum = finished.proposal?.payouts.reduce(
      (s, p) => s.plus(toDecimal(p.amount)),
      toDecimal('0'),
    );
    expect(sum?.equals(toDecimal('1200'))).toBe(true);
  });

  it("a holder sees only their own payments: A's position has A's two payments and nothing of the others", async () => {
    const position = await positionOf('holderA');
    expect(position.units).toBe(100);
    expect(position.payments.map((p) => p.status)).toEqual(['paid', 'paid']);
    expect(position.payments.map((p) => p.cycleLabel).sort()).toEqual(
      [`${clean.name} ${clean.id.slice(0, 4)}`, `${flagged.name} ${flagged.id.slice(0, 4)}`].sort(),
    );
    const reply = await as('holderA').get('/api/me/position');
    const { parties } = stack;
    for (const other of [parties.holderB, parties.holderC, parties.holderD, parties.treasury]) {
      expect(reply.body).not.toContain(other);
    }
    for (const name of ['Holder B', 'Holder C', 'Holder D', '150.0000000000']) {
      expect(reply.body).not.toContain(name);
    }
    // The treasury screens are not for holders.
    for (const path of ['/api/overview', '/api/holders', '/api/activity', '/api/cycles']) {
      expect((await as('holderA').get(path)).status).toBe(403);
    }
    // And holders cannot reach another holder's payment.
    const dPayment = (await positionOf('holderD')).payments[0]?.paymentId ?? '';
    expect((await as('holderA').post(`/api/me/payments/${dPayment}/accept`)).status).toBe(404);
  });

  it('shows the overview, the cycles and the activity log', async () => {
    const overview = OverviewResponseSchema.parse(
      (await as('treasurer').get('/api/overview')).json(),
    );
    // 50,000 test CC minus the two distributions.
    expect(
      overview.balance !== null && toDecimal(overview.balance).equals(toDecimal('48500')),
    ).toBe(true);
    expect(overview.pendingApprovals).toBe(0);
    expect(overview.mandate?.terms.approvalThreshold).toBe(2);
    expect(overview.recentCycles.map((c) => [c.cycleId, c.status]).sort()).toEqual(
      [
        [clean.id, 'paid-automatically'],
        [flagged.id, 'paid-after-approval'],
      ].sort(),
    );
    expect(overview.nextCycle?.label).toBeTruthy();

    // Contract ids travel in URL parameters: the router accepts up to 300 characters (the route
    // itself then refuses an id over 200 as an invalid request: a 400, not a missing route).
    const longId = await as('treasurer').get<{ error: { code: string } }>(
      `/api/decision-records/${'a'.repeat(250)}`,
    );
    expect(longId.status).toBe(400);
    expect(longId.json().error.code).not.toBe('not_found');

    const cycles = CyclesResponseSchema.parse((await as('approver3').get('/api/cycles')).json());
    expect(cycles.cycles).toHaveLength(2);
    expect(cycles.cycles.every((c) => !c.seeded)).toBe(true);

    const entries = ActivityResponseSchema.parse(
      (await as('treasurer').get('/api/activity?limit=200')).json(),
    ).entries;
    const kinds = new Set(entries.map((e) => e.kind));
    for (const kind of [
      'org.created',
      'units.issued',
      'cycle.proposed',
      'proposal.approved',
      'payment.accepted',
    ]) {
      expect(kinds, `activity kind ${kind}`).toContain(kind);
    }
    expect(
      entries.some((e) => e.actor?.displayName === 'Approver 1' && e.kind === 'proposal.approved'),
    ).toBe(true);
  });

  it('streamed live updates to the treasurer: timeline steps and cycle status changes', () => {
    const timeline = live.filter((e) => e.type === 'timeline');
    const cycle = live.filter((e) => e.type === 'cycle');
    expect(timeline.length).toBeGreaterThanOrEqual(7);
    expect(cycle.length).toBeGreaterThan(0);
    const steps = new Set(
      timeline.flatMap((e) => (e.type === 'timeline' && e.cycleId === clean.id ? [e.step.id] : [])),
    );
    for (const id of ['woke', 'snapshot', 'amounts', 'checks', 'review', 'verdict', 'execute']) {
      expect(steps, `timeline step ${id}`).toContain(id);
    }
    expect(
      cycle.some(
        (e) => e.type === 'cycle' && e.cycleId === clean.id && e.status === 'paid-automatically',
      ),
    ).toBe(true);
    expect(live.some((e) => e.type === 'activity')).toBe(true);
  });
});
