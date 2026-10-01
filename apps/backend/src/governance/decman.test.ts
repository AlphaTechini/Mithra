import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PolicyFields } from '@mithra/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../config/env';
import type { SealRequestRow } from '../db/schema';
import {
  createMithraCommands,
  mithraTemplateIds,
  type Contract,
  type Ledger,
  type LedgerClient,
  type Mandate,
  type Organization,
  type SubmitInput,
  type Transaction,
} from '../ledger';
import type { PartyNames } from '../parties/names';
import { localnetTestConfig, mainnetTestConfig } from '../testConfig';
import { createDecmanSealer, parseConfirmations } from './decman';
import { createMainnetSealer } from './mainnet';
import { prepareSeal, type DraftSource, type SealStore } from './sealer';

const TREASURY = 'treasury::1220aa';
const TREASURER = 'treasurer::1220aa';
const AGENT = 'agent::1220aa';
const OPERATOR = 'operator::1220aa';
const PROPOSAL_CID = 'proposal-cid-0001';

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

interface RecordedRequest {
  node: string;
  method: string;
  path: string;
  body: unknown;
}

/** A DecMan node that records requests and answers like the real one is assumed to. */
class StubDecman {
  readonly requests: RecordedRequest[] = [];
  /** Confirmations by proposal cid, shared by all nodes (they replicate through the ledger). */
  static confirmations = new Map<string, { contract_id: string; confirmer: string }[]>();
  server: Server;
  url = '';
  online = true;
  executeStatus = 200;

  constructor(
    readonly id: string,
    readonly member: string,
  ) {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(
    req: IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
    const path = req.url ?? '';
    this.requests.push({ node: this.id, method: req.method ?? '', path, body });
    if (!this.online) {
      res.writeHead(503).end('node offline');
      return;
    }
    const json = (status: number, value: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    };
    if (req.method === 'POST' && path === '/governance/confirm') {
      const cid = String(body?.['proposal_cid']);
      const list = StubDecman.confirmations.get(cid) ?? [];
      if (!list.some((c) => c.confirmer === this.member)) {
        list.push({ contract_id: `conf-${this.id}`, confirmer: this.member });
      }
      StubDecman.confirmations.set(cid, list);
      json(200, { status: 'ok' });
    } else if (req.method === 'GET' && path.startsWith('/governance/confirmations')) {
      const domainActions = [...StubDecman.confirmations.entries()].map(([cid, confirmations]) => ({
        proposal_cid: cid,
        description: 'MithraSealMandate',
        confirmations,
        can_execute: confirmations.length >= 2,
      }));
      json(200, { core_actions: [], domain_actions: domainActions });
    } else if (req.method === 'POST' && path === '/governance/execute') {
      json(
        this.executeStatus,
        this.executeStatus === 200 ? { status: 'ok' } : { error: 'rejected' },
      );
    } else {
      json(404, { error: 'not found' });
    }
  }
}

function memoryStore(): SealStore & { rows: Map<string, SealRequestRow> } {
  const rows = new Map<string, SealRequestRow>();
  return {
    rows,
    insert(row) {
      const full: SealRequestRow = { ...row, createdAt: new Date(), updatedAt: new Date() };
      rows.set(row.sealId, full);
      return Promise.resolve(full);
    },
    get: (id) => Promise.resolve(rows.get(id) ?? null),
    update(id, patch) {
      const existing = rows.get(id);
      if (!existing) throw new Error('missing');
      const next = { ...existing, ...patch, updatedAt: new Date() };
      rows.set(id, next);
      return Promise.resolve(next);
    },
    pendingIds: () =>
      Promise.resolve(
        [...rows.values()].filter((r) => r.state === 'awaiting-nodes').map((r) => r.sealId),
      ),
  };
}

function tx(entity: string, contractId: string): Transaction {
  return {
    updateId: 'upd',
    offset: 1,
    effectiveAt: '2026-10-01T10:00:00Z',
    recordTime: '2026-10-01T10:00:00Z',
    synchronizerId: 's',
    events: [
      {
        kind: 'created',
        contractId,
        templateId: `pkg:${entity}`,
        entity,
        createArgument: {},
        signatories: [],
        observers: [],
        createdAt: '2026-10-01T10:00:00Z',
        offset: 1,
        interfaceViews: [],
      },
    ],
  };
}

const organization = (version: number): Contract<Organization> => ({
  contractId: 'org-1',
  createdAt: '2026-09-01T00:00:00Z',
  payload: {
    treasury: TREASURY,
    treasurer: TREASURER,
    agent: AGENT,
    operator: OPERATOR,
    name: 'Acme Fund',
    asset: { admin: 'dso::1220aa', id: 'Amulet' },
    approvers: fields.approvers,
    approvalThreshold: 2,
    mandateVersion: version,
  },
});

describe('DecMan sealer against a stub Decentralization Manager', () => {
  let nodes: StubDecman[];
  let config: Config;
  let store: ReturnType<typeof memoryStore>;
  let submitted: SubmitInput[];
  let orgVersion: number;
  let currentMandate: Contract<Mandate> | null;
  let ledger: Pick<Ledger, 'client' | 'reader' | 'commands'>;
  let drafts: DraftSource;
  const names = {
    name: (p: string) => Promise.resolve(p.split('::')[0] ?? p),
  } as unknown as PartyNames;

  beforeEach(async () => {
    StubDecman.confirmations = new Map();
    nodes = [
      new StubDecman('a', 'member-a'),
      new StubDecman('b', 'member-b'),
      new StubDecman('c', 'member-c'),
    ];
    for (const n of nodes) await n.start();
    const base = localnetTestConfig({
      parties: { treasury: TREASURY, agent: AGENT, operator: OPERATOR },
    });
    config = {
      ...base,
      localnet: {
        ...base.localnet!,
        nodes: nodes.map((n, i) => ({
          id: n.id,
          name: `Node ${n.id.toUpperCase()}`,
          operator: `Op ${n.id.toUpperCase()}`,
          jsonApiUrl: 'http://localhost:1',
          decmanUrl: n.url,
          autoConfirm: i < 2,
        })),
        decmanGovernanceThreshold: 2,
        decmanGovernanceRulesCid: 'rules-cid-1',
        decmanMemberParties: { a: 'member-a', b: 'member-b', c: 'member-c' },
      },
    } as Config;
    store = memoryStore();
    submitted = [];
    orgVersion = 0;
    currentMandate = null;
    ledger = {
      client: {
        submit(input: SubmitInput): Promise<Transaction> {
          submitted.push(input);
          const command = input.commands[0];
          const templateId =
            command && 'CreateCommand' in command ? command.CreateCommand.templateId : '';
          if (templateId.endsWith(':Mithra.Mandate:MandateSealRequest')) {
            return Promise.resolve(tx('Mithra.Mandate:MandateSealRequest', 'seal-request-cid'));
          }
          if (templateId.endsWith(':Mithra.Governance:MandateChangeProposal')) {
            return Promise.resolve(tx('Mithra.Governance:MandateChangeProposal', PROPOSAL_CID));
          }
          return Promise.resolve(tx('Other:Other', 'other'));
        },
      } as unknown as LedgerClient,
      reader: {
        organization: () => Promise.resolve(organization(orgVersion)),
        mandate: () => Promise.resolve(currentMandate),
      } as unknown as Ledger['reader'],
      commands: createMithraCommands(mithraTemplateIds('#mithra-v1')),
    };
    drafts = {
      get: (id) =>
        Promise.resolve(id === 'draft-1' ? { draft: { fields }, party: TREASURER } : null),
    };
  });

  afterEach(async () => {
    for (const n of nodes) await n.stop();
  });

  const sealer = (fetchOverride?: typeof fetch) =>
    createDecmanSealer({
      config,
      ledger,
      store,
      drafts,
      names,
      ...(fetchOverride ? { fetch: fetchOverride } : {}),
    });

  it('the treasurer signs the request, the operator files the governed action, autoConfirm nodes confirm', async () => {
    const status = await sealer().start('draft-1', TREASURER);

    expect(submitted).toHaveLength(2);
    const [request, proposal] = submitted;
    // L6: the treasurer signs the Mandate terms; the agent signs nothing.
    expect(request?.actAs).toEqual([TREASURER]);
    expect(request?.commands[0]).toMatchObject({
      CreateCommand: {
        templateId: '#mithra-v1:Mithra.Mandate:MandateSealRequest',
        createArguments: {
          treasury: TREASURY,
          treasurer: TREASURER,
          agent: AGENT,
          agentExecutes: true,
          terms: {
            cap: '5000',
            approvalThreshold: '2',
            asset: { admin: 'dso::1220aa', id: 'Amulet' },
          },
        },
      },
    });
    const created = (
      request?.commands[0] as { CreateCommand: { createArguments: Record<string, string> } }
    ).CreateCommand.createArguments;
    expect(created['summary']).toContain('Schedule: Monthly on the 1st at 09:00 UTC.');
    expect(created['summaryFingerprint']).toMatch(/^[0-9a-f]{64}$/);

    expect(proposal?.actAs).toEqual([OPERATOR]);
    expect(proposal?.commands[0]).toMatchObject({
      CreateCommand: {
        templateId: '#mithra-v1:Mithra.Governance:MandateChangeProposal',
        createArguments: {
          governanceParty: TREASURY,
          proposer: OPERATOR,
          orgCid: 'org-1',
          sealRequestCid: 'seal-request-cid',
          currentMandateCid: null,
          description: 'Seal Mandate v1: cap 5,000 CC, 2 of 3 approvals',
        },
      },
    });

    const confirms = nodes.flatMap((n) =>
      n.requests.filter((r) => r.path === '/governance/confirm'),
    );
    expect(confirms.map((r) => r.node)).toEqual(['a', 'b']); // node c does not auto-confirm
    expect(confirms[0]?.body).toEqual({
      party_id: TREASURY,
      rules_contract_id: 'rules-cid-1',
      action: { type: 'generic_vote', description: 'MithraSealMandate' },
      governance_type: 'core_domain',
      proposal_cid: PROPOSAL_CID,
    });

    expect(status).toMatchObject({
      state: 'awaiting-nodes',
      treasurerSigned: true,
      mandateVersion: null,
      error: null,
      nodeConfirmations: {
        required: 2,
        confirmed: 2,
        nodes: [
          { id: 'a', name: 'Node A', operator: 'Op A', confirmed: true },
          { id: 'b', name: 'Node B', operator: 'Op B', confirmed: true },
          { id: 'c', name: 'Node C', operator: 'Op C', confirmed: false },
        ],
      },
    });
  });

  it('N8: does not execute below the confirmation threshold, executes once it is met, then reports sealed', async () => {
    nodes[1]!.online = false; // node B is offline while the action is filed
    const s = sealer();
    const started = await s.start('draft-1', TREASURER);
    expect(started.nodeConfirmations?.confirmed).toBe(1);

    // 1 of 2: advancing must not execute.
    const waiting = await s.advance(started.sealId);
    expect(waiting.state).toBe('awaiting-nodes');
    expect(
      nodes.flatMap((n) => n.requests).filter((r) => r.path === '/governance/execute'),
    ).toHaveLength(0);

    // Node B comes back: the retry confirms, the threshold is met, the action is executed on a confirming node.
    nodes[1]!.online = true;
    const executed = await s.advance(started.sealId);
    expect(executed.nodeConfirmations?.confirmed).toBe(2);
    const executes = nodes
      .flatMap((n) => n.requests)
      .filter((r) => r.path === '/governance/execute');
    expect(executes).toHaveLength(1);
    expect(executes[0]).toMatchObject({
      node: 'a',
      body: {
        party_id: TREASURY,
        rules_contract_id: 'rules-cid-1',
        action: { type: 'generic_vote', description: 'MithraSealMandate' },
        governance_type: 'core_domain',
        proposal_cid: PROPOSAL_CID,
        disclosed_contracts: [],
      },
    });
    expect((executes[0]?.body as { confirmation_cids: string[] }).confirmation_cids.sort()).toEqual(
      ['conf-a', 'conf-b'],
    );
    expect(executed.state).toBe('awaiting-nodes'); // not sealed until the ledger shows the new Mandate

    // Executing again is not repeated while we wait for the ledger.
    await s.advance(started.sealId);
    expect(
      nodes.flatMap((n) => n.requests).filter((r) => r.path === '/governance/execute'),
    ).toHaveLength(1);

    // Org_ApplySeal ran: the organization's version moved.
    orgVersion = 1;
    const sealed = await s.advance(started.sealId);
    expect(sealed).toMatchObject({ state: 'sealed', mandateVersion: 1, error: null });
  });

  it('attributes confirmations to nodes through DECMAN_MEMBER_PARTIES, including a node confirmed in its own UI', async () => {
    const s = sealer();
    const started = await s.start('draft-1', TREASURER);
    // Node C's operator confirms in their own DecMan.
    StubDecman.confirmations
      .get(PROPOSAL_CID)
      ?.push({ contract_id: 'conf-c', confirmer: 'member-c' });
    const after = await s.advance(started.sealId);
    expect(after.nodeConfirmations?.nodes.map((n) => n.confirmed)).toEqual([true, true, true]);
    expect(after.nodeConfirmations?.confirmed).toBe(3);
  });

  it("reports a rejected execution as failed with DecMan's answer", async () => {
    nodes[0]!.executeStatus = 400;
    const s = sealer();
    const started = await s.start('draft-1', TREASURER);
    const failed = await s.advance(started.sealId);
    expect(failed.state).toBe('failed');
    expect(failed.error).toContain('The governed action could not be executed');
    expect(failed.error).toContain('HTTP 400');
    expect(await s.advance(started.sealId)).toMatchObject({ state: 'failed' }); // terminal
  });

  it('withdraws the signed request and reports failure when the governed action cannot be filed', async () => {
    const original = ledger.client.submit.bind(ledger.client);
    (ledger.client as unknown as { submit: typeof original }).submit = (input) => {
      if (input.actAs[0] === OPERATOR) return Promise.reject(new Error('operator cannot propose'));
      return original(input);
    };
    const status = await sealer().start('draft-1', TREASURER);
    expect(status.state).toBe('failed');
    expect(status.error).toContain('operator cannot propose');
    // The treasurer's request is withdrawn so nothing dangles.
    expect(submitted.at(-1)?.commands[0]).toMatchObject({
      ExerciseCommand: { choice: 'SealRequest_Withdraw', contractId: 'seal-request-cid' },
    });
  });

  it('survives a DecMan node that does not answer at all', async () => {
    await nodes[1]!.stop();
    const status = await sealer().start('draft-1', TREASURER);
    expect(status.state).toBe('awaiting-nodes');
    expect(status.nodeConfirmations?.confirmed).toBe(1);
  });

  it('pending lists seals waiting for nodes', async () => {
    const s = sealer();
    const started = await s.start('draft-1', TREASURER);
    expect(await s.pending()).toEqual([started.sealId]);
    orgVersion = 1;
    await s.advance(started.sealId);
    expect(await s.pending()).toEqual([]);
  });

  it('the description numbers the next version when a Mandate already exists', async () => {
    orgVersion = 2;
    currentMandate = {
      contractId: 'mandate-2',
      createdAt: '2026-09-01T00:00:00Z',
      payload: {} as Mandate,
    };
    await sealer().start('draft-1', TREASURER);
    expect(submitted[1]?.commands[0]).toMatchObject({
      CreateCommand: {
        createArguments: {
          currentMandateCid: 'mandate-2',
          description: 'Seal Mandate v3: cap 5,000 CC, 2 of 3 approvals',
        },
      },
    });
  });

  it("refuses a seal by someone who is not the treasurer, or of another party's draft, or an unknown draft", async () => {
    const s = sealer();
    await expect(s.start('draft-1', 'someone::1220aa')).rejects.toMatchObject({ status: 403 });
    await expect(s.start('missing', TREASURER)).rejects.toMatchObject({
      status: 404,
      code: 'draft_not_found',
    });
    drafts = { get: () => Promise.resolve({ draft: { fields }, party: 'other::1220aa' }) };
    await expect(sealer().start('draft-1', TREASURER)).rejects.toMatchObject({
      status: 403,
      code: 'not_your_draft',
    });
    expect(submitted).toHaveLength(0);
  });

  it('refuses an invalid draft before anything is signed', async () => {
    drafts = {
      get: () =>
        Promise.resolve({
          draft: { fields: { ...fields, approvers: [AGENT, 'ap2::1220aa'] } },
          party: TREASURER,
        }),
    };
    await expect(sealer().start('draft-1', TREASURER)).rejects.toMatchObject({
      status: 422,
      code: 'invalid_policy',
    });
    expect(submitted).toHaveLength(0);
  });

  it('prepareSeal builds the same summary the draft shows and fingerprints it', async () => {
    const prepared = await prepareSeal({ config, ledger, drafts, names }, 'draft-1', TREASURER);
    expect(prepared.nextVersion).toBe(1);
    expect(prepared.summaryFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.terms.asset).toEqual({ admin: 'dso::1220aa', id: 'Amulet' });
  });

  it('MainNet returns awaiting-signature with a clear error', async () => {
    const main = mainnetTestConfig();
    const mainConfig: Config = { ...main, parties: config.parties };
    const mainSealer = createMainnetSealer({ config: mainConfig, ledger, drafts, names, store });
    const status = await mainSealer.start('draft-1', TREASURER);
    expect(status).toMatchObject({
      state: 'awaiting-signature',
      treasurerSigned: false,
      nodeConfirmations: null,
      error: 'Signing in Grofty arrives with the MainNet build',
    });
    expect(submitted).toHaveLength(0);
    expect(await mainSealer.status(status.sealId)).toEqual(status);
    expect(await mainSealer.pending()).toEqual([]);
  });
});

describe('parseConfirmations', () => {
  it('reads confirmation objects with a contract id and the confirming member', () => {
    const json = {
      domain_actions: [
        {
          proposal_cid: 'p1',
          confirmations: [{ contract_id: 'c1', confirmer: 'm1' }],
          can_execute: false,
        },
        {
          proposal_cid: 'p2',
          confirmations: [{ contract_id: 'c2', confirmer: 'm2' }, { cid: 'c3' }],
          can_execute: true,
        },
      ],
    };
    expect(parseConfirmations(json, 'p2')).toEqual({
      cids: ['c2', 'c3'],
      confirmers: ['m2'],
      canExecute: true,
    });
    expect(parseConfirmations(json, 'p1')).toEqual({
      cids: ['c1'],
      confirmers: ['m1'],
      canExecute: false,
    });
  });

  it('reads confirmations given as plain contract id strings, at any depth', () => {
    expect(
      parseConfirmations(
        { state: { actions: [{ proposal_cid: 'pp', confirmations: ['x', 'y'] }] } },
        'pp',
      ),
    ).toEqual({ cids: ['x', 'y'], confirmers: [], canExecute: false });
  });

  it('finds nothing for an unknown proposal or an unexpected body', () => {
    expect(parseConfirmations({ domain_actions: [] }, 'p')).toEqual({
      cids: [],
      confirmers: [],
      canExecute: false,
    });
    expect(parseConfirmations('oops', 'p').cids).toEqual([]);
    expect(parseConfirmations(null, 'p').cids).toEqual([]);
  });
});
