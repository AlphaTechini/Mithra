import { describe, expect, it } from 'vitest';
import { ApiError } from '../http/errors';
import type { Contract, MithraPayloads } from '../ledger';
import { localnetTestConfig } from '../testConfig';
import type { Database } from '../db';
import {
  createAgentServices,
  defaultPolicyFields,
  ORGANIZATION_DEFAULTS_DRAFT_ID,
} from './agentServices';

const config = localnetTestConfig({
  parties: { treasury: 'treasury::1220aa', agent: 'agent::1220aa', operator: 'operator::1220aa' },
});
const NAMES: Record<string, string> = {
  'approver1::1220aa': 'Approver 1',
  'approver2::1220aa': 'Approver 2',
  'approver3::1220aa': 'Approver 3',
  'holderA::1220aa': 'Holder A',
  'holderB::1220aa': 'Holder B',
};
const names = {
  name: (partyId: string) => Promise.resolve(NAMES[partyId] ?? partyId),
  ref: (partyId: string) => Promise.resolve({ partyId, displayName: NAMES[partyId] ?? partyId }),
};

function contract<T>(payload: T): Contract<T> {
  return { contractId: 'cid', payload, createdAt: '2026-09-01T00:00:00Z' };
}

const organization = contract({
  approvers: ['approver1::1220aa', 'approver2::1220aa', 'approver3::1220aa'],
  approvalThreshold: 2,
  name: 'Northwind',
} as MithraPayloads['Organization']);

function payment(
  holder: string,
  amount: string,
  cycleLabel: string,
  executedAt: string,
  status: 'Paid' | 'AwaitingAcceptance',
) {
  return contract({ holder, amount, cycleLabel, executedAt, status } as MithraPayloads['Payment']);
}

/** A database that answers the one query `parties()` makes: invites that name a party. */
function dbWithInvites(rows: { partyId: string | null; displayName: string }[]): Database {
  return { select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }) } as never;
}

function services(
  over: {
    drafts?: unknown;
    reader?: unknown;
    invites?: { partyId: string | null; displayName: string }[];
  } = {},
) {
  return createAgentServices({
    config,
    db: dbWithInvites(over.invites ?? []),
    ledger: {
      reader: {
        organization: () => Promise.resolve(organization),
        mandate: () => Promise.resolve(null),
        payments: () => Promise.resolve([]),
        ...(over.reader as object),
      },
    } as never,
    cycle: {
      cycles: {
        getCycle: () => Promise.reject(new ApiError(404, 'cycle_not_found', 'no')),
        listCycles: () => Promise.resolve([]),
        run: () => Promise.resolve({ cycleId: '2026-09' }),
      },
      drafts: {
        latest: () => Promise.resolve(null),
        savePolicyDraft: () => Promise.reject(new Error('unused')),
        ...(over.drafts as object),
      },
    } as never,
    asset: { balance: () => Promise.reject(new Error('registry down')) } as never,
    names: names as never,
    holders: () => Promise.reject(new Error('unused')),
    holderAdmin: {
      issueUnits: () => Promise.resolve(),
      createInvite: () => Promise.reject(new Error('unused')),
    },
  });
}

describe('defaultPolicyFields', () => {
  it('is the policy of userflow 4 step 2 with the given approvers and threshold', () => {
    expect(defaultPolicyFields(['a', 'b', 'c'], 2)).toEqual({
      cap: '5000',
      approvers: ['a', 'b', 'c'],
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
    });
  });
});

describe('agent services', () => {
  it('currentDraft: the stored draft first', async () => {
    const stored = { draftId: 'stored' };
    const s = services({ drafts: { latest: () => Promise.resolve(stored) } });
    expect(await s.policy.currentDraft('treasurer::1220aa')).toBe(stored);
  });

  it('currentDraft: with an organization but no draft, a complete draft with its approvers and threshold', async () => {
    const draft = await services().policy.currentDraft('treasurer::1220aa');
    expect(draft?.draftId).toBe(ORGANIZATION_DEFAULTS_DRAFT_ID);
    expect(draft?.fields.approvers).toEqual(organization.payload.approvers);
    expect(draft?.fields.approvalThreshold).toBe(2);
    expect(draft?.fields.cap).toBe('5000');
    expect(draft?.summary).toContain('Approver 1, Approver 2, Approver 3');
    expect(draft?.agentCan.length).toBeGreaterThan(0);
  });

  it('currentDraft: null when there is no organization', async () => {
    const s = services({ reader: { organization: () => Promise.resolve(null) } });
    expect(await s.policy.currentDraft('treasurer::1220aa')).toBeNull();
  });

  it('parties: the demo parties and invited parties, without the system parties', async () => {
    const s = services({
      invites: [
        { partyId: 'newholder::1220bb', displayName: 'New Holder' },
        { partyId: 'treasurer::1220aa', displayName: 'Duplicate of a demo party' },
        { partyId: config.parties.agent, displayName: 'Agent as invite' },
        { partyId: null, displayName: 'No party yet' },
      ],
    });
    expect(await s.org.parties()).toEqual([
      { partyId: 'treasurer::1220aa', displayName: 'Treasurer' },
      { partyId: 'newholder::1220bb', displayName: 'New Holder' },
    ]);
  });

  it('history.payments: joins names and filters by holder and date range', async () => {
    const s = services({
      reader: {
        payments: () =>
          Promise.resolve([
            payment('holderA::1220aa', '10', 'July 2026', '2026-08-01T09:00:00Z', 'Paid'),
            payment(
              'holderB::1220aa',
              '30',
              'July 2026',
              '2026-08-01T09:00:00Z',
              'AwaitingAcceptance',
            ),
            payment('holderA::1220aa', '12', 'August 2026', '2026-09-01T09:00:00Z', 'Paid'),
          ]),
      },
    });
    expect(await s.history.payments({ holder: 'holderA::1220aa' })).toEqual([
      {
        holder: { partyId: 'holderA::1220aa', displayName: 'Holder A' },
        cycleLabel: 'July 2026',
        amount: '10',
        at: '2026-08-01T09:00:00Z',
        status: 'paid',
      },
      {
        holder: { partyId: 'holderA::1220aa', displayName: 'Holder A' },
        cycleLabel: 'August 2026',
        amount: '12',
        at: '2026-09-01T09:00:00Z',
        status: 'paid',
      },
    ]);
    const august = await s.history.payments({ from: '2026-09-01', to: '2026-09-30' });
    expect(august.map((p) => p.amount)).toEqual(['12']);
    const waiting = await s.history.payments({ holder: 'holderB::1220aa' });
    expect(waiting[0]?.status).toBe('awaiting-acceptance');
  });

  it('getCycle: an unknown cycle is null, other failures are not hidden', async () => {
    const s = services();
    expect(await s.cycles.getCycle('2026-09')).toBeNull();
    const broken = createAgentServices({
      config,
      db: dbWithInvites([]),
      ledger: { reader: {} } as never,
      cycle: {
        cycles: { getCycle: () => Promise.reject(new Error('ledger down')) },
        drafts: {},
      } as never,
      asset: {} as never,
      names: names as never,
      holders: () => Promise.reject(new Error('unused')),
      holderAdmin: {} as never,
    });
    await expect(broken.cycles.getCycle('2026-09')).rejects.toThrow('ledger down');
  });

  it('balance: null when the registry does not answer', async () => {
    expect(await services().org.balance()).toBeNull();
  });
});
