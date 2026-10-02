import { describe, expect, it } from 'vitest';
import { urlOf } from '../testUtils';
import { none, unsafeHmac, type TokenProvider } from './auth';
import { LedgerClient, createdIn, exerciseResultOf } from './client';
import { LedgerError, NODES_DID_NOT_CONFIRM_MESSAGE, setNodeConfirmationLogger } from './errors';

interface Call {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
  rawBody: unknown;
}

type Responder = (call: Call, index: number) => Response | Promise<Response> | Error;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeClient(responder: Responder, tokens: TokenProvider = none()) {
  const calls: Call[] = [];
  const delays: number[] = [];
  const fetchStub: typeof fetch = async (input, init) => {
    const rawBody = init?.body;
    const call: Call = {
      method: init?.method ?? 'GET',
      url: urlOf(input),
      headers: new Headers(init?.headers),
      body: typeof rawBody === 'string' ? (JSON.parse(rawBody) as unknown) : undefined,
      rawBody,
    };
    calls.push(call);
    const result = await responder(call, calls.length - 1);
    if (result instanceof Error) throw result;
    return result;
  };
  const client = new LedgerClient({
    baseUrl: 'http://ledger.test/',
    userId: 'user-1',
    tokens,
    fetch: fetchStub,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  });
  return { client, calls, delays };
}

const createdEvent = (contractId: string, templateId: string, payload: unknown) => ({
  offset: 5,
  contractId,
  templateId,
  createArgument: payload,
  signatories: ['p1'],
  observers: ['p2'],
  createdAt: '2026-10-01T00:00:00Z',
});

describe('submit', () => {
  const tx = {
    transaction: {
      updateId: 'u1',
      commandId: 'c1',
      effectiveAt: '2026-10-01T00:00:00Z',
      offset: 9,
      synchronizerId: 'sync::1',
      recordTime: '2026-10-01T00:00:01Z',
      events: [
        { CreatedEvent: createdEvent('cid1', 'pkg:Mithra.Org:Organization', { name: 'Acme' }) },
        {
          ExercisedEvent: {
            contractId: 'cid0',
            templateId: 'pkg:Mithra.Charter:TreasuryCharter',
            choice: 'Charter_CreateOrganization',
            choiceArgument: {},
            exerciseResult: { _1: 'a', _2: 'b' },
            consuming: true,
            actingParties: ['p1'],
          },
        },
        { ArchivedEvent: { contractId: 'cid0', templateId: 'pkg:Mithra.Charter:TreasuryCharter' } },
      ],
    },
  };

  it('sends the command with the user id, parties, command id and requested shape', async () => {
    const { client, calls } = makeClient(() => json(tx));
    const result = await client.submit({
      actAs: ['p1', 'p1'],
      readAs: ['p1', 'p3'],
      commandId: 'cmd-1',
      shape: 'LEDGER_EFFECTS',
      commands: [
        {
          CreateCommand: { templateId: '#mithra-v1:Mithra.Org:Organization', createArguments: {} },
        },
      ],
      disclosedContracts: [
        { templateId: 't', contractId: 'c', createdEventBlob: 'b', synchronizerId: 's' },
      ],
    });
    expect(calls[0]?.url).toBe('http://ledger.test/v2/commands/submit-and-wait-for-transaction');
    expect(calls[0]?.method).toBe('POST');
    const body = calls[0]?.body as {
      commands: Record<string, unknown>;
      transactionFormat: Record<string, unknown>;
    };
    expect(body.commands).toMatchObject({
      commandId: 'cmd-1',
      userId: 'user-1',
      actAs: ['p1'],
      readAs: ['p3'],
      disclosedContracts: [{ contractId: 'c' }],
    });
    expect(body.transactionFormat).toMatchObject({
      transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS',
    });
    expect(result.updateId).toBe('u1');
    expect(createdIn(result, 'Mithra.Org:Organization')).toHaveLength(1);
    expect(createdIn(result)[0]?.entity).toBe('Mithra.Org:Organization');
    expect(exerciseResultOf(result, 'Charter_CreateOrganization')).toEqual({ _1: 'a', _2: 'b' });
    expect(() => exerciseResultOf(result, 'Nope')).toThrow(/LEDGER_EFFECTS/);
    expect(result.events.map((e) => e.kind)).toEqual(['created', 'exercised', 'archived']);
  });

  it('omits the transaction format and a random command id is generated when none is given', async () => {
    const { client, calls } = makeClient(() => json(tx));
    await client.submit({ actAs: ['p1'], commands: [] });
    const body = calls[0]?.body as { commands: { commandId: string }; transactionFormat?: unknown };
    expect(body.transactionFormat).toBeUndefined();
    expect(body.commands.commandId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sends a bearer token when the provider has one', async () => {
    const { client, calls } = makeClient(
      () => json(tx),
      unsafeHmac({ secret: 'unsafe', audience: 'aud', userId: 'user-1' }),
    );
    await client.submit({ actAs: ['p1'], commands: [] });
    expect(calls[0]?.headers.get('authorization')).toMatch(/^Bearer ey/);
  });

  it('retries a network failure with the same command id', async () => {
    const { client, calls, delays } = makeClient((_call, i) =>
      i < 2 ? new TypeError('fetch failed') : json(tx),
    );
    const result = await client.submit({ actAs: ['p1'], commands: [] });
    expect(result.updateId).toBe('u1');
    expect(calls).toHaveLength(3);
    const ids = calls.map(
      (c) => (c.body as { commands: { commandId: string } }).commands.commandId,
    );
    expect(new Set(ids).size).toBe(1);
    expect(delays).toEqual([250, 500]);
  });

  it('retries a retryable ledger error, then gives up after the bounded number of attempts', async () => {
    const busy = () => json({ code: 'SERVICE_NOT_RUNNING', cause: 'busy', errorCategory: 1 }, 503);
    const { client, calls } = makeClient(busy);
    await expect(client.submit({ actAs: ['p1'], commands: [] })).rejects.toMatchObject({
      retryable: true,
    });
    expect(calls).toHaveLength(3);
  });

  it('does not retry an answer that is final', async () => {
    const { client, calls } = makeClient(() =>
      json(
        {
          code: 'DAML_FAILURE',
          cause:
            'Interpretation error: Error: User failure: UNHANDLED_EXCEPTION/DA.Exception.AssertionFailed:AssertionFailed (error category 9): Nope',
          errorCategory: 9,
        },
        400,
      ),
    );
    const error = await client.submit({ actAs: ['p1'], commands: [] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LedgerError);
    expect((error as LedgerError).message).toBe('Nope');
    expect(calls).toHaveLength(1);
  });
});

describe('activeContracts', () => {
  it('asks once with all filters for all parties, at the ledger end, and parses the array response', async () => {
    const { client, calls } = makeClient((call) => {
      if (call.url.endsWith('/v2/state/ledger-end')) return json({ offset: 77 });
      return json([
        {
          contractEntry: {
            JsActiveContract: {
              createdEvent: {
                ...createdEvent('c1', 'pkg:Mithra.Org:Organization', { name: 'A' }),
                createdEventBlob: 'blob',
                interfaceViews: [
                  {
                    interfaceId: 'pkg:I:Holding',
                    viewStatus: {},
                    viewValue: { amount: '1.0000000000' },
                  },
                ],
              },
              synchronizerId: 'sync::1',
            },
          },
        },
        {
          contractEntry: {
            JsActiveContract: {
              createdEvent: createdEvent('c1', 'pkg:Mithra.Org:Organization', { name: 'A' }),
              synchronizerId: 'sync::1',
            },
          },
        },
        {
          contractEntry: {
            JsActiveContract: {
              createdEvent: createdEvent('c2', 'pkg:Mithra.Units:UnitRegister', { changes: [] }),
              synchronizerId: 'sync::1',
            },
          },
        },
        { contractEntry: { JsEmpty: {} } },
      ]);
    });
    const result = await client.activeContracts({
      parties: ['a', 'b'],
      templateIds: ['#mithra-v1:Mithra.Org:Organization', '#mithra-v1:Mithra.Units:UnitRegister'],
      interfaceIds: ['#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding'],
      includeBlobs: true,
    });
    expect(calls).toHaveLength(2);
    const body = calls[1]?.body as {
      activeAtOffset: number;
      eventFormat: { filtersByParty: Record<string, { cumulative: unknown[] }>; verbose: boolean };
    };
    expect(body.activeAtOffset).toBe(77);
    expect(Object.keys(body.eventFormat.filtersByParty)).toEqual(['a', 'b']);
    expect(body.eventFormat.filtersByParty['a']?.cumulative).toHaveLength(3);
    expect(body.eventFormat.filtersByParty['a']?.cumulative[0]).toEqual({
      identifierFilter: {
        TemplateFilter: {
          value: {
            templateId: '#mithra-v1:Mithra.Org:Organization',
            includeCreatedEventBlob: true,
          },
        },
      },
    });
    expect(body.eventFormat.filtersByParty['a']?.cumulative[2]).toEqual({
      identifierFilter: {
        InterfaceFilter: {
          value: {
            interfaceId: '#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding',
            includeInterfaceView: true,
            includeCreatedEventBlob: true,
          },
        },
      },
    });
    expect(result.map((c) => [c.contractId, c.entity])).toEqual([
      ['c1', 'Mithra.Org:Organization'],
      ['c2', 'Mithra.Units:UnitRegister'],
    ]);
    expect(result[0]).toMatchObject({
      createdEventBlob: 'blob',
      synchronizerId: 'sync::1',
      signatories: ['p1'],
    });
    expect(result[0]?.interfaceViews[0]?.viewValue).toEqual({ amount: '1.0000000000' });
  });

  it('uses a wildcard filter when no template or interface is given, and skips the call for no parties', async () => {
    const { client, calls } = makeClient((call) =>
      call.url.endsWith('ledger-end') ? json({ offset: 1 }) : json([]),
    );
    expect(await client.activeContracts({ parties: [] })).toEqual([]);
    expect(calls).toHaveLength(0);
    await client.activeContracts({ parties: ['a'] });
    const body = calls[1]?.body as {
      eventFormat: { filtersByParty: Record<string, { cumulative: unknown[] }> };
    };
    expect(body.eventFormat.filtersByParty['a']?.cumulative).toEqual([
      { identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } },
    ]);
  });
});

describe('other calls', () => {
  it('reads the ledger end, version and synchronizers', async () => {
    const { client } = makeClient((call) => {
      if (call.url.endsWith('/v2/state/ledger-end')) return json({ offset: 14 });
      if (call.url.endsWith('/v2/version')) return json({ version: '3.4.0-rc2', features: {} });
      return json({
        connectedSynchronizers: [{ synchronizerAlias: 'global', synchronizerId: 'global::12' }],
      });
    });
    expect(await client.ledgerEnd()).toBe(14);
    expect(await client.version()).toEqual({ version: '3.4.0-rc2' });
    expect(await client.connectedSynchronizers()).toEqual([
      { synchronizerAlias: 'global', synchronizerId: 'global::12' },
    ]);
  });

  it('allocates a party and waits while the node has no synchronizer yet', async () => {
    const { client, calls, delays } = makeClient((_call, i) =>
      i < 2
        ? json(
            {
              code: 'PARTY_ALLOCATION_WITHOUT_CONNECTED_SYNCHRONIZER',
              cause: 'not yet',
              errorCategory: 9,
            },
            400,
          )
        : json({ partyDetails: { party: 'alice::1220', isLocal: true } }),
    );
    expect(await client.allocateParty('alice')).toBe('alice::1220');
    expect(calls[0]?.body).toEqual({ partyIdHint: 'alice', identityProviderId: '' });
    expect(delays).toEqual([2000, 2000]);
  });

  it('lists parties across pages', async () => {
    const { client, calls } = makeClient((call) =>
      call.url.includes('pageToken=next')
        ? json({ partyDetails: [{ party: 'b::1', isLocal: false }], nextPageToken: '' })
        : json({ partyDetails: [{ party: 'a::1', isLocal: true }], nextPageToken: 'next' }),
    );
    expect(await client.listParties()).toEqual([
      { party: 'a::1', isLocal: true },
      { party: 'b::1', isLocal: false },
    ]);
    expect(calls).toHaveLength(2);
  });

  it('grants act-as and read-as rights', async () => {
    const { client, calls } = makeClient(() => json({}));
    await client.grantRights('user 1', ['a'], ['b', 'c']);
    expect(calls[0]?.url).toBe('http://ledger.test/v2/users/user%201/rights');
    expect(calls[0]?.body).toEqual({
      userId: 'user 1',
      rights: [
        { kind: { CanActAs: { value: { party: 'a' } } } },
        { kind: { CanReadAs: { value: { party: 'b' } } } },
        { kind: { CanReadAs: { value: { party: 'c' } } } },
      ],
    });
    await client.grantRights('user 1', [], []);
    expect(calls).toHaveLength(1);
  });

  it('uploads a DAR as octet-stream bytes', async () => {
    const { client, calls } = makeClient(() => json({}));
    const bytes = new Uint8Array([1, 2, 3]);
    await client.uploadDar(bytes);
    expect(calls[0]?.url).toBe('http://ledger.test/v2/dars');
    expect(calls[0]?.headers.get('content-type')).toBe('application/octet-stream');
    expect(calls[0]?.rawBody).toBe(bytes);
  });

  it('reads an update by id', async () => {
    const { client, calls } = makeClient(() =>
      json({
        update: {
          Transaction: {
            value: {
              updateId: 'u9',
              effectiveAt: '2026-10-01T00:00:00Z',
              offset: 3,
              events: [{ CreatedEvent: createdEvent('c9', 'pkg:Mithra.Org:Organization', {}) }],
            },
          },
        },
      }),
    );
    const tx = await client.updateById('u9', ['p1']);
    expect(tx.updateId).toBe('u9');
    expect(createdIn(tx)).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://ledger.test/v2/updates/update-by-id');
    expect(calls[0]?.body).toMatchObject({ updateId: 'u9' });
  });

  it('atUrl uses another node with the same credentials', async () => {
    const { client, calls } = makeClient(() => json({ version: '3.4.0' }));
    await client.atUrl('http://other.test:2975/').version();
    expect(calls[0]?.url).toBe('http://other.test:2975/v2/version');
  });

  it('reports an unreachable ledger as a retryable LedgerError that names LEDGER_JSON_API_URL', async () => {
    const { client } = makeClient(() => new TypeError('fetch failed'));
    const error = await client.version().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LedgerError);
    expect(error).toMatchObject({ code: 'LEDGER_UNREACHABLE', retryable: true, status: 0 });
    expect((error as LedgerError).message).toContain('LEDGER_JSON_API_URL');
  });
  it('reports a submission that times out as the treasury nodes not confirming (N8), but a read as a plain timeout', async () => {
    const lines: string[] = [];
    setNodeConfirmationLogger((line) => lines.push(line));
    try {
      const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      const { client } = makeClient(() => timeout);
      const submitted = await client
        .submit({ actAs: ['p1'], commands: [], shape: 'LEDGER_EFFECTS' })
        .catch((e: unknown) => e);
      expect(submitted).toMatchObject({
        code: 'LEDGER_TIMEOUT',
        message: NODES_DID_NOT_CONFIRM_MESSAGE,
        retryable: true,
        status: 0,
      });
      expect(lines.length).toBeGreaterThan(0);
      const read = await client.version().catch((e: unknown) => e);
      expect((read as LedgerError).message).toContain('did not answer in time');
    } finally {
      setNodeConfirmationLogger(undefined);
    }
  });
});
