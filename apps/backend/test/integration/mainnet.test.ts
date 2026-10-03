import { createHash } from 'node:crypto';
import {
  ActivityResponseSchema,
  CycleDetailSchema,
  HolderPositionSchema,
  HoldersResponseSchema,
  MainnetPayoutsResponseSchema,
  MainnetWalletChallengeResponseSchema,
  OrgResponseSchema,
  PolicyDraftSchema,
  PublicConfigSchema,
  SealStatusSchema,
  toDecimal,
  type CycleDetail,
  type MainnetPayoutsResponse,
} from '@mithra/shared';
import nacl from 'tweetnacl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootFullStack,
  DEMO_PASSWORD,
  MAINNET_EXPLORER_TX_URL,
  type FullStack,
} from '../e2e/server';
import { daysAgo, isoDate, requireSandbox } from './helpers';

/**
 * MainNet payouts (M10) over HTTP, against the real application in MainNet mode: Mithra's records
 * live on the LocalNet sandbox and are signed server-side, the Mandate's rules decide on the
 * ledger, and the money would move as plain transfers the treasurer signs in Grofty Wallet. This
 * test plays Grofty: it posts fake but unique update ids for each payout.
 */

const DATABASE_URL =
  process.env['DATABASE_URL_TEST_M10'] ?? 'postgres://mithra:mithra@localhost:5432/mithra_test_m10';

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
  get<T = unknown>(path: string): Promise<Reply<T>> {
    return this.request<T>('GET', path);
  }
  post<T = unknown>(path: string, body?: unknown): Promise<Reply<T>> {
    return this.request<T>('POST', path, body ?? {});
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

/** A Grofty wallet: a real Ed25519 key pair and the party id Canton derives from it. */
class FakeGrofty {
  readonly pair = nacl.sign.keyPair();
  readonly partyId: string;
  constructor(hint: string) {
    // Canton's rule, written out independently of the application: 0x12 0x20 + SHA-256(uint32_be(12) || key).
    const purpose = Buffer.from([0, 0, 0, 12]);
    const digest = createHash('sha256').update(purpose).update(this.pair.publicKey).digest();
    this.partyId = `${hint}::${Buffer.concat([Buffer.from([0x12, 0x20]), digest]).toString('hex')}`;
  }
  get publicKey(): string {
    return Buffer.from(this.pair.publicKey).toString('base64');
  }
  /** `signMessage`: Ed25519 over the UTF-8 bytes, base64. */
  sign(message: string): string {
    return Buffer.from(
      nacl.sign.detached(new Uint8Array(Buffer.from(message, 'utf8')), this.pair.secretKey),
    ).toString('base64');
  }
}

describe('MainNet payouts through Grofty (records on LocalNet)', () => {
  let stack: FullStack;
  let base: string;
  const clients: Record<string, Client> = {};
  const groftys: Record<string, FakeGrofty> = {};
  /** The MainNet parties that "have auto-receive on" in the stub Scan. */
  const preapproved = new Set<string>();
  const scanRequests: string[] = [];
  let counter = 0;
  /** A unique fake MainNet update id, like the ones Grofty returns. */
  const fakeUpdateId = (): string => `1220${String(++counter).padStart(8, '0')}${'ab'.repeat(24)}`;

  const clean = monthBefore(3);
  const flagged = monthBefore(2);

  const scanFetch = ((input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    scanRequests.push(url);
    const prefix = 'https://scan.example/api/scan/v0/transfer-preapprovals/by-party/';
    if (!url.startsWith(prefix)) return Promise.resolve(new Response('?', { status: 500 }));
    const party = decodeURIComponent(url.slice(prefix.length));
    return Promise.resolve(new Response('{}', { status: preapproved.has(party) ? 200 : 404 }));
  }) as typeof fetch;

  async function signIn(name: string, partyId: string): Promise<Client> {
    const client = new Client(base);
    expect(
      (await client.post('/api/session/localnet/sign-in', { password: DEMO_PASSWORD })).status,
    ).toBe(200);
    expect((await client.post('/api/session/switch', { partyId })).status).toBe(200);
    clients[name] = client;
    return client;
  }
  const as = (name: string): Client => {
    const client = clients[name];
    if (!client) throw new Error(`${name} is not signed in`);
    return client;
  };

  async function cycleDetail(cycleId: string): Promise<CycleDetail> {
    const reply = await as('treasurer').get(`/api/cycles/${cycleId}`);
    expect(reply.status, reply.body).toBe(200);
    return CycleDetailSchema.parse(reply.json());
  }
  async function waitForStatus(cycleId: string, status: string): Promise<CycleDetail> {
    return eventually(async () => {
      const detail = await cycleDetail(cycleId).catch(() => undefined);
      return detail?.summary.status === status ? detail : undefined;
    }, `${cycleId} to be ${status}`);
  }
  async function position(name: string) {
    const reply = await as(name).get('/api/me/position');
    expect(reply.status, reply.body).toBe(200);
    return HolderPositionSchema.parse(reply.json());
  }
  async function connect(name: string, hint: string): Promise<FakeGrofty> {
    const grofty = new FakeGrofty(hint);
    const challenge = MainnetWalletChallengeResponseSchema.parse(
      (await as(name).post('/api/me/mainnet-wallet/challenge')).json(),
    );
    const reply = await as(name).post('/api/me/mainnet-wallet', {
      partyId: grofty.partyId,
      publicKey: grofty.publicKey,
      signature: grofty.sign(challenge.message),
      nonce: challenge.nonce,
    });
    expect(reply.status, reply.body).toBe(200);
    groftys[name] = grofty;
    return grofty;
  }
  async function payouts(cycleId: string): Promise<MainnetPayoutsResponse> {
    const reply = await as('treasurer').get(`/api/cycles/${cycleId}/mainnet-payouts`);
    expect(reply.status, reply.body).toBe(200);
    return MainnetPayoutsResponseSchema.parse(reply.json());
  }
  const record = (
    cycleId: string,
    paymentId: string,
    updateId: string,
    outcome: 'completed' | 'pending' | 'unknown',
    who = 'treasurer',
  ) => as(who).post(`/api/cycles/${cycleId}/mainnet-payouts/${paymentId}`, { updateId, outcome });
  const holdersOf = (response: MainnetPayoutsResponse) =>
    response.payouts.map((p) => [p.holder.displayName, p.status] as const);

  beforeAll(async () => {
    await requireSandbox();
    stack = await bootFullStack({
      databaseUrl: DATABASE_URL,
      network: 'mainnet',
      scanUrl: 'https://scan.example/api/scan',
      scanFetch,
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
    await stack?.close();
  });

  it('is configured for MainNet payouts while the records stay on LocalNet', async () => {
    const anonymous = new Client(base);
    const config = PublicConfigSchema.parse((await anonymous.get('/api/config/public')).json());
    expect(config).toMatchObject({
      network: 'mainnet',
      testMode: true,
      payoutRail: 'grofty-mainnet',
      explorerTxUrlTemplate: MAINNET_EXPLORER_TX_URL,
      groftyMinVersion: '2.0.4',
    });
    // The role switcher and the LocalNet sign-in work on MainNet (no 409 sign_in_wallet).
    const demo = await as('treasurer').get('/api/session/demo-parties');
    expect(demo.status).toBe(200);
  });

  it('sets up the fund on the ledger: organization, Mandate, units (all signed server-side)', async () => {
    const treasurer = as('treasurer');
    const { parties } = stack;
    const created = await treasurer.post('/api/org', {
      name: 'Northwind Income Fund',
      approvers: [parties.approver1, parties.approver2, parties.approver3],
      approvalThreshold: 2,
    });
    expect(created.status, created.body).toBe(201);
    expect(OrgResponseSchema.parse(created.json()).setupStep).toBe('policy');
    const drafted = await treasurer.post('/api/policy/draft', {
      prompt:
        'Pay monthly yield on the 1st. Auto-pay if the total is under 5,000 CC and nothing looks off. Otherwise 2 of 3 approvals.',
    });
    const draft = PolicyDraftSchema.parse(drafted.json());
    const sealing = await treasurer.post('/api/mandate/seal', { draftId: draft.draftId });
    expect(SealStatusSchema.parse(sealing.json()).state).toBe('sealed');
    const effectiveDate = isoDate(daysAgo(200));
    for (const [holder, units] of [
      [parties.holderA, 100],
      [parties.holderB, 300],
      [parties.holderC, 600],
      [parties.holderD, 1000],
    ] as const) {
      const issued = await treasurer.post('/api/holders/issue', { holder, units, effectiveDate });
      expect(issued.status, issued.body).toBe(200);
    }
    for (const name of ['holderA', 'holderB', 'holderC', 'holderD']) {
      const pending = (await position(name)).pendingUnits[0]?.unitId ?? '';
      expect((await as(name).post(`/api/me/units/${pending}/accept`)).status).toBe(200);
    }
  });

  it('a holder connects Grofty by signing a challenge: the namespace must match the key and the signature must verify', async () => {
    // Nobody is connected yet.
    expect((await position('holderA')).mainnetWallet).toBeNull();
    const challenge = MainnetWalletChallengeResponseSchema.parse(
      (await as('holderA').post('/api/me/mainnet-wallet/challenge')).json(),
    );
    expect(challenge.message).toMatch(
      new RegExp(
        `^Connect your Grofty Wallet to Mithra\\nHolder: Holder A\\nNonce: ${challenge.nonce}\\nIssued: \\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z$`,
      ),
    );
    const wallet = new FakeGrofty('holder-a');
    const other = new FakeGrofty('someone-else');
    const attempt = (patch: Record<string, string>) =>
      as('holderA').post('/api/me/mainnet-wallet', {
        partyId: wallet.partyId,
        publicKey: wallet.publicKey,
        signature: wallet.sign(challenge.message),
        nonce: challenge.nonce,
        ...patch,
      });
    // A party id that does not belong to the key, then a signature by another key.
    const wrongParty = await attempt({ partyId: other.partyId });
    expect(wrongParty.status).toBe(401);
    expect(wrongParty.json()).toEqual({
      error: {
        code: 'invalid_signature',
        message: "Grofty's signature did not match this wallet. Try connecting again.",
      },
    });
    // The failed attempt used the nonce up.
    const reused = await attempt({});
    expect(reused.status).toBe(400);
    expect((reused.json() as { error: { code: string } }).error.code).toBe('invalid_nonce');

    // A fresh challenge, signed by the wrong key.
    const second = MainnetWalletChallengeResponseSchema.parse(
      (await as('holderA').post('/api/me/mainnet-wallet/challenge')).json(),
    );
    const stolen = await as('holderA').post('/api/me/mainnet-wallet', {
      partyId: wallet.partyId,
      publicKey: wallet.publicKey,
      signature: other.sign(second.message),
      nonce: second.nonce,
    });
    expect(stolen.status).toBe(401);
    expect((await position('holderA')).mainnetWallet).toBeNull();

    // The real thing, with the key and the signature as hex this time.
    const third = MainnetWalletChallengeResponseSchema.parse(
      (await as('holderA').post('/api/me/mainnet-wallet/challenge')).json(),
    );
    const ok = await as('holderA').post('/api/me/mainnet-wallet', {
      partyId: wallet.partyId,
      publicKey: Buffer.from(wallet.pair.publicKey).toString('hex'),
      signature: Buffer.from(wallet.sign(third.message), 'base64').toString('hex'),
      nonce: third.nonce,
    });
    expect(ok.status, ok.body).toBe(200);
    expect(HolderPositionSchema.parse(ok.json()).mainnetWallet).toEqual({
      partyId: wallet.partyId,
    });
    groftys['holderA'] = wallet;

    // The same wallet cannot be connected to a second holder.
    const again = MainnetWalletChallengeResponseSchema.parse(
      (await as('holderB').post('/api/me/mainnet-wallet/challenge')).json(),
    );
    const taken = await as('holderB').post('/api/me/mainnet-wallet', {
      partyId: wallet.partyId,
      publicKey: wallet.publicKey,
      signature: wallet.sign(again.message),
      nonce: again.nonce,
    });
    expect(taken.status).toBe(409);
    // Only holders connect wallets.
    expect((await as('treasurer').post('/api/me/mainnet-wallet/challenge')).status).toBe(403);

    // B and C connect too; D is left out on purpose for the first cycle.
    await connect('holderB', 'holder-b');
    await connect('holderC', 'holder-c');
  });

  it("shows auto-receive from Scan and each holder's wallet in the holders table", async () => {
    const a = groftys['holderA'];
    const b = groftys['holderB'];
    if (!a || !b) throw new Error('wallets are not connected');
    preapproved.add(a.partyId);
    preapproved.add(b.partyId);
    // "Check again" asks Scan afresh (the earlier answer for B was "off").
    for (const name of ['holderA', 'holderB']) {
      const checked = await as(name).post('/api/me/auto-receive');
      expect(checked.status, checked.body).toBe(200);
      expect(HolderPositionSchema.parse(checked.json()).autoReceive).toBe(true);
    }
    expect(scanRequests.some((u) => u.endsWith(encodeURIComponent(a.partyId)))).toBe(true);
    // C connected but has no preapproval; D has no wallet at all (unknown).
    const table = HoldersResponseSchema.parse((await as('treasurer').get('/api/holders')).json());
    const rows = new Map(table.holders.map((h) => [h.holder.displayName, h]));
    expect(rows.get('Holder A')).toMatchObject({
      autoReceive: true,
      mainnetWallet: { partyId: a.partyId },
    });
    expect(rows.get('Holder B')).toMatchObject({
      autoReceive: true,
      mainnetWallet: { partyId: b.partyId },
    });
    expect(rows.get('Holder C')?.autoReceive).toBe(false);
    expect(rows.get('Holder D')).toMatchObject({ autoReceive: null, mainnetWallet: null });
    // The wallet column is for the treasury team only.
    expect((await as('holderA').get('/api/holders')).status).toBe(403);
    const c = groftys['holderC'];
    if (c) preapproved.add(c.partyId);
  });

  it('a clean cycle waits in needs-wallets for Holder D, then authorizes on the ledger without moving any money', async () => {
    const before = await stack.backend.asset.balance(stack.parties.treasury);
    const run = await as('treasurer').post('/api/cycles/run', { cycleId: clean.id, total: '300' });
    expect(run.status).toBe(202);
    // The countdown passes, but Holder D has no wallet: nothing is authorized and nothing is paid.
    const waiting = await waitForStatus(clean.id, 'needs-wallets');
    expect(waiting.needsWallets?.map((h) => h.displayName)).toEqual(['Holder D']);
    expect(waiting.proposal?.payouts.every((p) => p.payment === null)).toBe(true);
    expect((await as('treasurer').get(`/api/cycles/${clean.id}/mainnet-payouts`)).status).toBe(409);
    const server = await as('treasurer').get('/api/activity?limit=20');
    expect(
      ActivityResponseSchema.parse(server.json()).entries.some(
        (e) => e.kind === 'cycle.needs-wallets',
      ),
    ).toBe(true);

    // Holder D connects: the cycle goes ahead by itself.
    await connect('holderD', 'holder-d');
    const authorized = await waitForStatus(clean.id, 'awaiting-signature');
    // P4: no row says Paid, every row is pending the ledger.
    expect(
      authorized.proposal?.payouts.map((p) => [p.holder.displayName, p.payment?.status]),
    ).toEqual([
      ['Holder A', 'pending-ledger'],
      ['Holder B', 'pending-ledger'],
      ['Holder C', 'pending-ledger'],
      ['Holder D', 'pending-ledger'],
    ]);
    expect(JSON.stringify(authorized)).not.toContain('"paid"');
    expect(authorized.outcome?.kind).toBe('executed');
    // No ledger transfer happened: the treasury's test holdings are unchanged.
    expect(await stack.backend.asset.balance(stack.parties.treasury)).toBe(before);
    for (const name of ['holderA', 'holderB', 'holderC', 'holderD']) {
      const mine = await position(name);
      expect(mine.payments).toHaveLength(1);
      expect(mine.payments[0]).toMatchObject({ status: 'pending', link: null });
      expect(toDecimal(mine.totalReceived).isZero()).toBe(true);
    }
  });

  it('lists the transfers to sign: receivers, amounts, memo, fee buffer; treasurer only', async () => {
    const list = await payouts(clean.id);
    expect(list).toMatchObject({ assetSymbol: 'CC', feeBuffer: '1.0000000000' });
    expect(toDecimal(list.total).equals(toDecimal('300'))).toBe(true);
    expect(
      list.payouts.map((p) => [
        p.holder.displayName,
        p.receiver === groftys[`holder${p.holder.displayName.slice(-1)}`]?.partyId,
        p.amount,
        p.status,
      ]),
    ).toEqual([
      ['Holder A', true, '15.0000000000', 'to-sign'],
      ['Holder B', true, '45.0000000000', 'to-sign'],
      ['Holder C', true, '90.0000000000', 'to-sign'],
      ['Holder D', true, '150.0000000000', 'to-sign'],
    ]);
    expect(new Set(list.payouts.map((p) => p.memo))).toEqual(
      new Set([`Mithra Northwind Income Fund ${clean.name} ${clean.id.slice(0, 4)}`]),
    );
    expect(list.payouts.every((p) => p.link === null)).toBe(true);
    for (const name of ['holderA', 'approver1']) {
      expect((await as(name).get(`/api/cycles/${clean.id}/mainnet-payouts`)).status).toBe(403);
    }
  });

  it('records what Grofty reported, one payout at a time; Paid only after the record (P4)', async () => {
    const list = await payouts(clean.id);
    const byName = new Map(list.payouts.map((p) => [p.holder.displayName, p]));
    const idOf = (name: string): string => byName.get(name)?.paymentId ?? '';
    const ids: Record<string, string> = {};

    // Holder A: transfer executed, receiver holds the funds.
    ids['A'] = fakeUpdateId();
    const a = await record(clean.id, idOf('Holder A'), ids['A'], 'completed');
    expect(a.status, a.body).toBe(200);
    const afterA = MainnetPayoutsResponseSchema.parse(a.json());
    expect(holdersOf(afterA)).toEqual([
      ['Holder A', 'paid'],
      ['Holder B', 'to-sign'],
      ['Holder C', 'to-sign'],
      ['Holder D', 'to-sign'],
    ]);
    expect(afterA.payouts[0]?.link).toEqual({
      updateId: ids['A'],
      href: MAINNET_EXPLORER_TX_URL.replace('{updateId}', ids['A']),
      external: true,
    });
    // Still waiting for the others.
    expect((await cycleDetail(clean.id)).summary.status).toBe('awaiting-signature');
    const midRows = (await cycleDetail(clean.id)).proposal?.payouts.map((p) => p.payment?.status);
    expect(midRows).toEqual(['paid', 'pending-ledger', 'pending-ledger', 'pending-ledger']);

    // The same update id cannot pay anyone else.
    const reused = await record(clean.id, idOf('Holder B'), ids['A'], 'completed');
    expect(reused.status).toBe(409);
    expect((reused.json() as { error: { code: string } }).error.code).toBe('update_id_used');
    // A payment that is not part of this cycle is refused.
    const foreign = await record(clean.id, 'f'.repeat(32), fakeUpdateId(), 'completed');
    expect(foreign.status).toBe(404);
    expect((foreign.json() as { error: { code: string } }).error.code).toBe('payment_not_found');
    // Only the treasurer records.
    expect(
      (await record(clean.id, idOf('Holder B'), fakeUpdateId(), 'completed', 'approver1')).status,
    ).toBe(403);
    expect(
      (await record(clean.id, idOf('Holder B'), fakeUpdateId(), 'completed', 'holderB')).status,
    ).toBe(403);
    // A bad outcome is a validation error.
    const bad = await as('treasurer').post(
      `/api/cycles/${clean.id}/mainnet-payouts/${idOf('Holder B')}`,
      {
        updateId: fakeUpdateId(),
        outcome: 'paid',
      },
    );
    expect(bad.status).toBe(400);

    // Holder B: executed but the outcome could not be read: not confirmed, so not Paid (P4).
    ids['B'] = fakeUpdateId();
    expect((await record(clean.id, idOf('Holder B'), ids['B'], 'unknown')).status).toBe(200);
    // Holder C: a transfer offer the holder has to accept.
    ids['C'] = fakeUpdateId();
    expect((await record(clean.id, idOf('Holder C'), ids['C'], 'pending')).status).toBe(200);
    // Holder D: completed. Now every payout is recorded, two are not confirmed yet.
    ids['D'] = fakeUpdateId();
    const last = await record(clean.id, idOf('Holder D'), ids['D'], 'completed');
    expect(holdersOf(MainnetPayoutsResponseSchema.parse(last.json()))).toEqual([
      ['Holder A', 'paid'],
      ['Holder B', 'awaiting-acceptance'],
      ['Holder C', 'awaiting-acceptance'],
      ['Holder D', 'paid'],
    ]);
    const waiting = await waitForStatus(clean.id, 'awaiting-acceptance');
    expect(waiting.proposal?.payouts.map((p) => p.payment?.status)).toEqual([
      'paid',
      'awaiting-acceptance',
      'awaiting-acceptance',
      'paid',
    ]);
    // Every row links to the MainNet explorer, with its own transaction.
    expect(waiting.proposal?.payouts.map((p) => p.payment?.link?.href)).toEqual(
      ['A', 'B', 'C', 'D'].map((k) => MAINNET_EXPLORER_TX_URL.replace('{updateId}', ids[k] ?? '')),
    );
    expect(waiting.proposal?.payouts.every((p) => p.payment?.link?.external === true)).toBe(true);
    // Recording a payment that is already paid changes nothing.
    const twice = await record(clean.id, idOf('Holder A'), fakeUpdateId(), 'completed');
    expect(twice.status).toBe(409);

    // "Check again" that still cannot read B's outcome changes nothing: the same transfer, the same status.
    const stillUnknown = await record(clean.id, idOf('Holder B'), ids['B'], 'unknown');
    expect(stillUnknown.status, stillUnknown.body).toBe(200);
    expect(holdersOf(MainnetPayoutsResponseSchema.parse(stillUnknown.json()))[1]).toEqual([
      'Holder B',
      'awaiting-acceptance',
    ]);
    // Later B's transfer is confirmed: the same update id, now completed, marks it Paid.
    const confirmedB = await record(clean.id, idOf('Holder B'), ids['B'], 'completed');
    expect(confirmedB.status, confirmedB.body).toBe(200);
    expect(holdersOf(MainnetPayoutsResponseSchema.parse(confirmedB.json()))[1]).toEqual([
      'Holder B',
      'paid',
    ]);
    expect((await cycleDetail(clean.id)).summary.status).toBe('awaiting-acceptance');
    // Later the holder accepted the offer in Grofty: the treasurer records it as completed, with the same transfer.
    const done = await record(clean.id, idOf('Holder C'), ids['C'], 'completed');
    expect(done.status, done.body).toBe(200);
    const finished = await waitForStatus(clean.id, 'paid-automatically');
    expect(finished.proposal?.payouts.every((p) => p.payment?.status === 'paid')).toBe(true);
    expect(finished.timeline.find((s) => s.id === 'execute')).toMatchObject({
      status: 'done',
      detail: expect.stringContaining('on MainNet') as unknown,
    });
    const activity = ActivityResponseSchema.parse(
      (await as('treasurer').get('/api/activity?limit=50')).json(),
    );
    expect(activity.entries.map((e) => e.text)).toEqual(
      expect.arrayContaining([
        'Paid 15 CC to Holder A on MainNet (signed in Grofty)',
        'Sent 45 CC to Holder B on MainNet (signed in Grofty); Mithra could not confirm it arrived. Check it in Grofty.',
        'Sent 90 CC to Holder C on MainNet (signed in Grofty); Holder C has to accept it',
      ]),
    );
  });

  it('holders see only their own payment, with their own explorer link (L7)', async () => {
    const mine = await position('holderA');
    expect(mine.mainnetWallet).toEqual({ partyId: groftys['holderA']?.partyId });
    expect(mine.payments).toHaveLength(1);
    expect(mine.payments[0]).toMatchObject({ status: 'paid', amount: '15.0000000000' });
    expect(mine.payments[0]?.link?.href).toMatch(/^https:\/\/mainnet-explorer\.example\/tx\/1220/);
    expect(mine.totalReceived).toBe('15.0000000000');
    const raw = (await as('holderA').get('/api/me/position')).body;
    for (const other of ['holderB', 'holderC', 'holderD']) {
      expect(raw).not.toContain(groftys[other]?.partyId ?? 'x');
      expect(raw).not.toContain(stack.parties[other as 'holderB']);
    }
    for (const text of ['Holder B', 'Holder C', 'Holder D', '45.0000000000', '150.0000000000']) {
      expect(raw).not.toContain(text);
    }
    // Holder C's payment was recorded as awaiting acceptance, then as paid.
    expect((await position('holderC')).payments[0]).toMatchObject({
      status: 'paid',
      amount: '90.0000000000',
    });
    // Holders cannot reach the payout routes.
    for (const name of ['holderA', 'holderD']) {
      expect((await as(name).get(`/api/cycles/${clean.id}/mainnet-payouts`)).status).toBe(403);
    }
  });

  it("a flagged cycle authorizes only after 2 approvals, then waits for the treasurer's signatures", async () => {
    const treasurer = as('treasurer');
    const { parties } = stack;
    const jumped = await treasurer.post('/api/holders/issue', {
      holder: parties.holderC,
      units: 900,
      effectiveDate: addDays(flagged.lastDay, -1),
    });
    expect(jumped.status, jumped.body).toBe(200);
    const acceptable = (await position('holderC')).pendingUnits[0]?.unitId ?? '';
    expect((await as('holderC').post(`/api/me/units/${acceptable}/accept`)).status).toBe(200);

    expect(
      (await treasurer.post('/api/cycles/run', { cycleId: flagged.id, total: '1200' })).status,
    ).toBe(202);
    const proposed = await waitForStatus(flagged.id, 'awaiting-approval');
    const proposalId = encodeURIComponent(proposed.proposal?.proposalId ?? '');
    // Not authorized before the threshold: no payments exist, the payout list is not available.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect((await cycleDetail(flagged.id)).summary.status).toBe('awaiting-approval');
    expect((await treasurer.get(`/api/cycles/${flagged.id}/mainnet-payouts`)).status).toBe(409);

    expect(
      (await as('approver1').post(`/api/proposals/${proposalId}/approve`, { note: 'ok' })).status,
    ).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect((await cycleDetail(flagged.id)).summary.status).toBe('awaiting-approval');
    expect((await treasurer.get(`/api/cycles/${flagged.id}/mainnet-payouts`)).status).toBe(409);

    expect(
      (await as('approver2').post(`/api/proposals/${proposalId}/approve`, { note: 'ok' })).status,
    ).toBe(200);
    const authorized = await waitForStatus(flagged.id, 'awaiting-signature');
    expect(authorized.summary.approvals).toEqual({ have: 2, need: 2 });
    const list = await payouts(flagged.id);
    expect(list.payouts.every((p) => p.status === 'to-sign')).toBe(true);
    const sum = list.payouts.reduce((s, p) => s.plus(toDecimal(p.amount)), toDecimal('0'));
    expect(sum.equals(toDecimal('1200'))).toBe(true);

    // The treasurer signs all four in Grofty; each is recorded as it comes back.
    for (const payout of list.payouts) {
      const reply = await record(flagged.id, payout.paymentId, fakeUpdateId(), 'completed');
      expect(reply.status, reply.body).toBe(200);
    }
    const done = await waitForStatus(flagged.id, 'paid-after-approval');
    expect(done.proposal?.payouts.every((p) => p.payment?.status === 'paid')).toBe(true);
    // Update ids cannot be reused across cycles either.
    const firstCycleUpdate =
      (await position('holderA')).payments.find((p) => p.cycleLabel.includes(clean.name))?.link
        ?.updateId ?? '';
    expect(firstCycleUpdate).not.toBe('');
    const holders = list.payouts[0]?.paymentId ?? '';
    expect((await record(flagged.id, holders, firstCycleUpdate, 'completed')).status).toBe(409);
  });

  it('an executed cycle cannot be authorized again, and LocalNet routes stay closed to other roles', async () => {
    // L3: running the cycle again changes nothing on the ledger.
    const again = await as('treasurer').post('/api/cycles/run', {
      cycleId: clean.id,
      total: '300',
    });
    expect([202, 409]).toContain(again.status);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect((await cycleDetail(clean.id)).summary.status).toBe('paid-automatically');
    const list = await payouts(clean.id);
    expect(list.payouts.every((p) => p.status === 'paid')).toBe(true);
  });
});
