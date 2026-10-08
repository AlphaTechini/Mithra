import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { none, type TokenProvider } from '../ledger/auth';
import { jsonBodyOf, urlOf } from '../testUtils';
import { LedgerClient } from '../ledger/client';
import { RegistryError, createTokenStandardAdapter, HOLDING_INTERFACE_ID } from './tokenStandard';

interface Recorded {
  method: string;
  url: string;
  body: unknown;
  authorization?: string | undefined;
}

const DISCLOSED = {
  templateId: 'pkg:Splice.AmuletRules:AmuletRules',
  contractId: '00rules',
  createdEventBlob: 'blob-1',
  synchronizerId: 'global::12',
  debugPackageName: 'splice-amulet',
};

let server: Server;
let baseUrl: string;
let recorded: Recorded[] = [];
let respond: (req: Recorded) => { status: number; body: unknown } = () => ({
  status: 404,
  body: {},
});

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : (JSON.parse(text) as unknown);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void readBody(req).then((body) => {
      const entry = {
        method: req.method ?? '',
        url: req.url ?? '',
        body,
        authorization: req.headers.authorization,
      };
      recorded.push(entry);
      const { status, body: out } = respond(entry);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  recorded = [];
  respond = () => ({ status: 404, body: {} });
});

const instrument = { admin: 'dso::1220', id: 'Amulet' };
const fixedNow = new Date('2026-10-01T09:00:00Z');

function adapter(ledgerFetch?: typeof fetch, auth?: TokenProvider) {
  const ledger = new LedgerClient({
    baseUrl: 'http://ledger.test',
    userId: 'u',
    tokens: none(),
    ...(ledgerFetch ? { fetch: ledgerFetch } : {}),
  });
  return createTokenStandardAdapter({
    ledger,
    registryUrl: `${baseUrl}/api/validator/v0/scan-proxy/`,
    instrument,
    now: () => fixedNow,
    ...(auth ? { auth } : {}),
  });
}

describe('transferLeg', () => {
  it('sends the bearer token when the registry needs one, and none otherwise', async () => {
    respond = () => ({
      status: 200,
      body: { factoryId: '00factory', transferKind: 'direct', choiceContext: {} },
    });
    const leg = { sender: 'treasury::1', receiver: 'holder::2', amount: '1' };
    await adapter(undefined, { getToken: () => Promise.resolve('tok-1') }).transferLeg(leg);
    await adapter().transferLeg(leg);

    expect(recorded.map((r) => r.authorization)).toEqual(['Bearer tok-1', undefined]);
  });

  it('asks the registry for the factory and turns the answer into a leg with disclosed contracts', async () => {
    respond = () => ({
      status: 200,
      body: {
        factoryId: '00factory',
        transferKind: 'direct',
        choiceContext: {
          choiceContextData: {
            values: {
              'amulet-rules': { tag: 'AV_ContractId', value: '00rules' },
              'open-round': { tag: 'AV_ContractId', value: '00round' },
            },
          },
          disclosedContracts: [DISCLOSED],
        },
      },
    });
    const result = await adapter().transferLeg({
      sender: 'treasury::1',
      receiver: 'holder::2',
      amount: '1234.5',
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.method).toBe('POST');
    expect(recorded[0]?.url).toBe(
      '/api/validator/v0/scan-proxy/registry/transfer-instruction/v1/transfer-factory',
    );
    expect(recorded[0]?.body).toEqual({
      choiceArguments: {
        expectedAdmin: 'dso::1220',
        transfer: {
          sender: 'treasury::1',
          receiver: 'holder::2',
          amount: '1234.5',
          instrumentId: { admin: 'dso::1220', id: 'Amulet' },
          requestedAt: '2026-10-01T08:59:00.000Z',
          executeBefore: '2026-10-02T09:00:00.000Z',
          inputHoldingCids: [],
          meta: { values: {} },
        },
        extraArgs: { context: { values: {} }, meta: { values: {} } },
      },
      excludeDebugFields: true,
    });

    expect(result.kind).toBe('direct');
    expect(result.leg).toEqual({
      holder: 'holder::2',
      factoryCid: '00factory',
      extraArgs: {
        context: {
          values: {
            'amulet-rules': { tag: 'AV_ContractId', value: '00rules' },
            'open-round': { tag: 'AV_ContractId', value: '00round' },
          },
        },
        meta: { values: {} },
      },
    });
    // Only the fields the ledger needs are passed on.
    expect(result.disclosed).toEqual([
      {
        templateId: DISCLOSED.templateId,
        contractId: '00rules',
        createdEventBlob: 'blob-1',
        synchronizerId: 'global::12',
      },
    ]);
  });

  it('reports offer and self transfers and copes with an empty context', async () => {
    respond = () => ({
      status: 200,
      body: {
        factoryId: '00f',
        transferKind: 'offer',
        choiceContext: { choiceContextData: {}, disclosedContracts: [] },
      },
    });
    const offer = await adapter().transferLeg({ sender: 'a', receiver: 'b', amount: '1' });
    expect(offer.kind).toBe('offer');
    expect(offer.leg.extraArgs.context.values).toEqual({});
    expect(offer.disclosed).toEqual([]);
  });

  it('refuses an amount that is not a decimal string before calling the registry', async () => {
    await expect(
      adapter().transferLeg({ sender: 'a', receiver: 'b', amount: '1e3' }),
    ).rejects.toThrow();
    expect(recorded).toHaveLength(0);
  });

  it('throws a RegistryError that says what happened when the registry refuses', async () => {
    respond = () => ({ status: 404, body: { error: 'no such instrument' } });
    const error = await adapter()
      .transferLeg({ sender: 'a', receiver: 'b', amount: '1' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RegistryError);
    expect((error as RegistryError).status).toBe(404);
    expect((error as RegistryError).message).toContain('HTTP 404');
  });

  it('throws a RegistryError for a response of the wrong shape', async () => {
    respond = () => ({
      status: 200,
      body: { factoryId: '00f', transferKind: 'weird', choiceContext: {} },
    });
    await expect(
      adapter().transferLeg({ sender: 'a', receiver: 'b', amount: '1' }),
    ).rejects.toThrow(/unexpected response/);
  });

  it('names REGISTRY_URL when the registry cannot be reached', async () => {
    const down = createTokenStandardAdapter({
      ledger: new LedgerClient({ baseUrl: 'http://ledger.test', userId: 'u', tokens: none() }),
      registryUrl: 'http://127.0.0.1:1',
      instrument,
    });
    await expect(down.transferLeg({ sender: 'a', receiver: 'b', amount: '1' })).rejects.toThrow(
      /REGISTRY_URL/,
    );
  });
});

describe('acceptContext', () => {
  it('fetches the accept context of a transfer instruction', async () => {
    respond = () => ({
      status: 200,
      body: {
        choiceContextData: {
          values: { 'amulet-rules': { tag: 'AV_ContractId', value: '00rules' } },
        },
        disclosedContracts: [DISCLOSED],
      },
    });
    const result = await adapter().acceptContext('00instr');
    expect(recorded[0]?.url).toBe(
      '/api/validator/v0/scan-proxy/registry/transfer-instruction/v1/00instr/choice-contexts/accept',
    );
    expect(recorded[0]?.body).toEqual({ meta: {}, excludeDebugFields: true });
    expect(result.extraArgs.context.values['amulet-rules']).toEqual({
      tag: 'AV_ContractId',
      value: '00rules',
    });
    expect(result.disclosed).toHaveLength(1);
  });
});

describe('holdings and balance', () => {
  const holdingView = (owner: string, amount: string, extra: Record<string, unknown> = {}) => ({
    interfaceId: `pkg:Splice.Api.Token.HoldingV1:Holding`,
    viewStatus: {},
    viewValue: {
      owner,
      instrumentId: instrument,
      amount,
      lock: null,
      meta: { values: {} },
      ...extra,
    },
  });

  const entry = (cid: string, view: unknown) => ({
    contractEntry: {
      JsActiveContract: {
        createdEvent: {
          offset: 1,
          contractId: cid,
          templateId: 'pkg:Splice.Amulet:Amulet',
          createArgument: {},
          signatories: [],
          observers: [],
          createdAt: '2026-10-01T00:00:00Z',
          interfaceViews: [view],
        },
        synchronizerId: 's',
      },
    },
  });

  function ledgerFetch(items: unknown[]): { fetch: typeof fetch; bodies: unknown[] } {
    const bodies: unknown[] = [];
    const stub: typeof fetch = (input, init) => {
      if (urlOf(input).endsWith('/v2/state/ledger-end')) {
        return Promise.resolve(new Response(JSON.stringify({ offset: 4 })));
      }
      bodies.push(jsonBodyOf(init));
      return Promise.resolve(new Response(JSON.stringify(items)));
    };
    return { fetch: stub, bodies };
  }

  it('lists holdings through the Holding interface, only the party instrument, and sums unlocked ones exactly', async () => {
    const { fetch: stub, bodies } = ledgerFetch([
      entry('00h1', holdingView('treasury::1', '1000.0000000001')),
      entry('00h2', holdingView('treasury::1', '0.0000000002')),
      entry('00h3', holdingView('treasury::1', '500', { lock: { holders: ['x'] } })),
      entry(
        '00h4',
        holdingView('treasury::1', '9', { instrumentId: { admin: 'dso::1220', id: 'Other' } }),
      ),
      entry('00h5', holdingView('someone::else', '77')),
      entry('00h6', { interfaceId: 'pkg:Other:Iface', viewValue: {} }),
    ]);
    const a = adapter(stub);
    const holdings = await a.holdings('treasury::1');
    expect(holdings.map((h) => [h.contractId, h.amount, h.locked])).toEqual([
      ['00h1', '1000.0000000001', false],
      ['00h2', '0.0000000002', false],
      ['00h3', '500', true],
    ]);
    // Sums as decimals, never as JS numbers: 1000.0000000001 + 0.0000000002.
    expect(await a.balance('treasury::1')).toBe('1000.0000000003');
    const filter = (
      bodies[0] as {
        eventFormat: {
          filtersByParty: Record<string, { cumulative: { identifierFilter: unknown }[] }>;
        };
      }
    ).eventFormat.filtersByParty['treasury::1']?.cumulative[0]?.identifierFilter;
    expect(filter).toEqual({
      InterfaceFilter: {
        value: {
          interfaceId: HOLDING_INTERFACE_ID,
          includeInterfaceView: true,
          includeCreatedEventBlob: false,
        },
      },
    });
  });

  it('has a zero balance without holdings', async () => {
    const { fetch: stub } = ledgerFetch([]);
    expect(await adapter(stub).balance('nobody::1')).toBe('0.0000000000');
  });

  it('exposes the configured instrument', () => {
    expect(adapter().instrument()).toEqual(instrument);
  });
});
