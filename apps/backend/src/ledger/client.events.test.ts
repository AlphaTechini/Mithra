import { describe, expect, it } from 'vitest';
import { urlOf, jsonBodyOf } from '../testUtils';
import { none } from './auth';
import { LedgerClient } from './client';
import { LedgerError } from './errors';

function clientFor(respond: (url: string, body: unknown) => Response) {
  const calls: { url: string; body: unknown }[] = [];
  const stub: typeof fetch = (input, init) => {
    const call = { url: urlOf(input), body: jsonBodyOf(init) };
    calls.push(call);
    return Promise.resolve(respond(call.url, call.body));
  };
  const client = new LedgerClient({
    baseUrl: 'http://ledger.test',
    userId: 'u',
    tokens: none(),
    fetch: stub,
  });
  return { client, calls };
}

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('eventsByContractId', () => {
  it('reads the archive offset of an archived contract', async () => {
    const { client, calls } = clientFor(() =>
      ok({
        created: { createdEvent: { offset: 10, contractId: 'c1' }, synchronizerId: 's' },
        archived: { archivedEvent: { offset: 15, contractId: 'c1' }, synchronizerId: 's' },
      }),
    );
    expect(await client.eventsByContractId('c1', ['treasury'])).toEqual({
      createdAtOffset: 10,
      archivedAtOffset: 15,
    });
    expect(calls[0]?.url).toBe('http://ledger.test/v2/events/events-by-contract-id');
    expect(calls[0]?.body).toMatchObject({
      contractId: 'c1',
      eventFormat: { filtersByParty: { treasury: { cumulative: expect.any(Array) as unknown } } },
    });
  });

  it('has no archive offset while the contract is active', async () => {
    const { client } = clientFor(() => ok({ created: { createdEvent: { offset: 10 } } }));
    expect(await client.eventsByContractId('c1', ['p'])).toEqual({
      createdAtOffset: 10,
      archivedAtOffset: null,
    });
  });

  it('throws a LedgerError with status 404 when the contract is not visible', async () => {
    const { client } = clientFor(
      () =>
        new Response(JSON.stringify({ code: 'CONTRACT_EVENTS_NOT_FOUND', cause: 'not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(client.eventsByContractId('c1', ['p'])).rejects.toBeInstanceOf(LedgerError);
    await expect(client.eventsByContractId('c1', ['p'])).rejects.toMatchObject({ status: 404 });
  });
});

describe('updateByOffset', () => {
  it('returns the transaction with its exercise events', async () => {
    const { client, calls } = clientFor(() =>
      ok({
        update: {
          Transaction: {
            value: {
              updateId: 'u-1',
              effectiveAt: '2026-10-01T10:00:00Z',
              offset: 15,
              events: [
                {
                  ExercisedEvent: {
                    contractId: 'c1',
                    templateId: 'pkg:Mod:Inst',
                    choice: 'TransferInstruction_Accept',
                    consuming: true,
                    actingParties: ['holder'],
                  },
                },
              ],
            },
          },
        },
      }),
    );
    const tx = await client.updateByOffset(15, ['treasury']);
    expect(tx.updateId).toBe('u-1');
    expect(tx.events[0]).toMatchObject({ kind: 'exercised', choice: 'TransferInstruction_Accept' });
    expect(calls[0]?.url).toBe('http://ledger.test/v2/updates/update-by-offset');
    expect(calls[0]?.body).toMatchObject({
      offset: 15,
      updateFormat: {
        includeTransactions: { transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS' },
      },
    });
  });
});
