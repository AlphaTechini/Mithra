import { describe, expect, it } from 'vitest';
import { jsonBodyOf, urlOf } from '../../testUtils';
import { none } from '../auth';
import { LedgerClient } from '../client';
import { MithraReader } from './queries';
import { mithraTemplateIds } from './templates';

function entry(
  contractId: string,
  entity: string,
  payload: unknown,
  createdAt = '2026-10-01T00:00:00Z',
) {
  return {
    contractEntry: {
      JsActiveContract: {
        createdEvent: {
          offset: 1,
          contractId,
          templateId: `pkgid:${entity}`,
          createArgument: payload,
          signatories: [],
          observers: [],
          createdAt,
        },
        synchronizerId: 's',
      },
    },
  };
}

const org = (treasury: string, name: string) => ({
  treasury,
  treasurer: 'r',
  agent: 'g',
  operator: 'o',
  name,
  asset: { admin: 'dso', id: 'Amulet' },
  approvers: ['a1'],
  approvalThreshold: '1',
  mandateVersion: '1',
});

const unit = (holder: string) => ({
  treasury: 'treasury::1',
  holder,
  orgName: 'Acme',
  units: '10',
  effectiveDate: '2026-01-01',
  issuedAt: '2026-01-01T00:00:00Z',
  accepted: false,
  seeded: false,
});

function readerWith(items: unknown[], readParties = ['agent::1', 'treasury::1']) {
  const bodies: unknown[] = [];
  const fetchStub: typeof fetch = (input, init) => {
    if (urlOf(input).endsWith('/v2/state/ledger-end'))
      return Promise.resolve(new Response('{"offset":2}'));
    bodies.push(jsonBodyOf(init));
    return Promise.resolve(new Response(JSON.stringify(items)));
  };
  const client = new LedgerClient({
    baseUrl: 'http://ledger.test',
    userId: 'u',
    tokens: none(),
    fetch: fetchStub,
  });
  return {
    bodies,
    reader: new MithraReader({
      client,
      templates: mithraTemplateIds('#mithra-v1'),
      treasuryParty: 'treasury::1',
      readParties,
    }),
  };
}

describe('MithraReader', () => {
  it("returns only the configured treasury's contracts, typed, newest first", async () => {
    const { reader, bodies } = readerWith([
      entry('00a', 'Mithra.Org:Organization', org('treasury::1', 'Old'), '2026-09-01T00:00:00Z'),
      entry('00b', 'Mithra.Org:Organization', org('treasury::other', 'Someone else')),
      entry('00c', 'Mithra.Org:Organization', org('treasury::1', 'New'), '2026-10-01T00:00:00Z'),
    ]);
    const result = await reader.organization();
    expect(result).toEqual({
      contractId: '00c',
      payload: expect.objectContaining({
        name: 'New',
        approvalThreshold: 1,
        mandateVersion: 1,
      }) as unknown,
      createdAt: '2026-10-01T00:00:00Z',
    });
    // One request, as the agent and the treasury, for the Organization template only.
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as {
      eventFormat: { filtersByParty: Record<string, { cumulative: unknown[] }> };
    };
    expect(Object.keys(body.eventFormat.filtersByParty)).toEqual(['agent::1', 'treasury::1']);
    expect(body.eventFormat.filtersByParty['agent::1']?.cumulative).toHaveLength(1);
  });

  it('returns null when there is no such contract', async () => {
    expect(await readerWith([]).reader.organization()).toBeNull();
  });

  it('filters fund units by holder', async () => {
    const { reader } = readerWith([
      entry('00a', 'Mithra.Units:FundUnit', unit('h1')),
      entry('00b', 'Mithra.Units:FundUnit', unit('h2')),
    ]);
    expect((await reader.fundUnits()).map((u) => u.contractId).sort()).toEqual(['00a', '00b']);
    expect((await reader.fundUnits('h2')).map((u) => u.contractId)).toEqual(['00b']);
  });

  it('reads as other parties with as()', async () => {
    const { reader, bodies } = readerWith([]);
    await reader.as(['holder::1']).payments();
    const body = bodies[0] as { eventFormat: { filtersByParty: Record<string, unknown> } };
    expect(Object.keys(body.eventFormat.filtersByParty)).toEqual(['holder::1']);
  });

  it('names the contract and field when the ledger sends something unexpected', async () => {
    const { reader } = readerWith([
      entry('00abcdef0123456789', 'Mithra.Org:Organization', {
        ...org('treasury::1', 'X'),
        approvalThreshold: 'two',
      }),
    ]);
    await expect(reader.organization()).rejects.toThrow(
      /Cannot read Organization 00abcdef0123.*approvalThreshold/,
    );
  });

  it('reads all role facts with one request', async () => {
    const { reader, bodies } = readerWith([
      entry('00a', 'Mithra.Org:Organization', org('treasury::1', 'Acme')),
    ]);
    const facts = await reader.roleFacts();
    expect(facts.organization?.contractId).toBe('00a');
    expect(facts.register).toBeNull();
    expect(bodies).toHaveLength(1);
  });
});
