import { describe, expect, it } from 'vitest';
import { jsonBodyOf, urlOf } from '../../testUtils';
import { none } from '../auth';
import { LedgerClient } from '../client';
import { compareInstants, MithraReader, newestFirst } from './queries';
import { mithraTemplateIds } from './templates';

function entry(
  contractId: string,
  entity: string,
  payload: unknown,
  createdAt = '2026-10-01T00:00:00Z',
  offset = 1,
) {
  return {
    contractEntry: {
      JsActiveContract: {
        createdEvent: {
          offset,
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
      offset: 1,
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

describe('newest first', () => {
  const contract = (contractId: string, createdAt: string, offset?: number) => ({
    contractId,
    createdAt,
    payload: null,
    ...(offset === undefined ? {} : { offset }),
  });

  it('compares instants with microseconds and with trimmed fractions', () => {
    // As strings "…24.254Z" sorts after "…24.254844Z" ('Z' > '8'), but it is the earlier instant.
    expect(compareInstants('2026-10-01T10:00:24.254Z', '2026-10-01T10:00:24.254844Z')).toBe(-1);
    expect(compareInstants('2026-10-01T10:00:24.254844Z', '2026-10-01T10:00:24.254Z')).toBe(1);
    expect(compareInstants('2026-10-01T10:00:24Z', '2026-10-01T10:00:24.000000Z')).toBe(0);
    expect(compareInstants('2026-10-01T10:00:25Z', '2026-10-01T10:00:24.999999Z')).toBe(1);
  });

  it('sorts by instant when there is no offset, not by string', () => {
    const older = contract('00a', '2026-10-01T10:00:24.254Z');
    const newer = contract('00b', '2026-10-01T10:00:24.254844Z');
    expect([older, newer].sort(newestFirst).map((c) => c.contractId)).toEqual(['00b', '00a']);
    expect([newer, older].sort(newestFirst).map((c) => c.contractId)).toEqual(['00b', '00a']);
  });

  it('sorts by ledger offset when both contracts carry different ones', () => {
    // The clock says the other order; the offset is the ledger's own order.
    const first = contract('00a', '2026-10-01T10:00:24.900Z', 7);
    const second = contract('00b', '2026-10-01T10:00:24.100Z', 9);
    expect([first, second].sort(newestFirst).map((c) => c.contractId)).toEqual(['00b', '00a']);
  });

  it('uses the contract id as the tiebreak', () => {
    const a = contract('00a', '2026-10-01T10:00:24Z', 5);
    const b = contract('00b', '2026-10-01T10:00:24.000000Z', 5);
    expect([a, b].sort(newestFirst).map((c) => c.contractId)).toEqual(['00b', '00a']);
    expect([b, a].sort(newestFirst).map((c) => c.contractId)).toEqual(['00b', '00a']);
  });

  it('the reader returns the newest contract of both timestamp forms and carries the offset', async () => {
    const { reader } = readerWith([
      entry(
        '00a',
        'Mithra.Org:Organization',
        org('treasury::1', 'Old'),
        '2026-10-01T10:00:24.254Z',
        3,
      ),
      entry(
        '00b',
        'Mithra.Org:Organization',
        org('treasury::1', 'New'),
        '2026-10-01T10:00:24.254844Z',
        3,
      ),
    ]);
    const result = await reader.organization();
    expect(result).toMatchObject({ contractId: '00b', offset: 3 });
  });
});
