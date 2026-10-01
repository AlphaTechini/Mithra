import { describe, expect, it } from 'vitest';
import { EventBus, type Published } from '../events/bus';
import { localnetTestConfig } from '../testConfig';
import type { Database } from '../db';
import { createHolderAdmin } from './admin';

const config = localnetTestConfig();
const TREASURER = 'treasurer::1220aa';
const HOLDER = 'holder::1220aa';

interface Harness {
  admin: ReturnType<typeof createHolderAdmin>;
  submitted: { actAs: string[]; commands: unknown[] }[];
  activity: { kind: string; text: string; seeded?: boolean }[];
  published: Published[];
  invites: Record<string, unknown>[];
  invalidated: number;
}

function harness(options: { organization?: boolean; takenCodes?: number } = {}): Harness {
  const h = {
    submitted: [] as Harness['submitted'],
    activity: [] as Harness['activity'],
    published: [] as Published[],
    invites: [] as Record<string, unknown>[],
    invalidated: 0,
  };
  const bus = new EventBus();
  bus.subscribe((p) => h.published.push(p));
  let taken = options.takenCodes ?? 0;
  const db = {
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: () => {
            if (taken > 0) {
              taken -= 1;
              return Promise.resolve([]);
            }
            h.invites.push(row);
            return Promise.resolve([row]);
          },
        }),
      }),
    }),
  } as unknown as Database;
  const withOrg = options.organization ?? true;
  const admin = createHolderAdmin({
    config,
    db,
    bus,
    now: () => new Date('2026-10-01T10:00:00Z'),
    names: {
      name: (p: string) => Promise.resolve(p === HOLDER ? 'Holder A' : p),
      invalidate: () => {
        h.invalidated += 1;
      },
    } as never,
    activity: {
      record: (input: { kind: string; text: string; seeded?: boolean }) => {
        h.activity.push(input);
        return Promise.resolve({});
      },
    } as never,
    ledger: {
      reader: {
        organization: () =>
          Promise.resolve(withOrg ? { contractId: 'org', payload: { name: 'Northwind' } } : null),
        register: () => Promise.resolve(withOrg ? { contractId: 'reg', payload: {} } : null),
      },
      client: {
        submit: (input: { actAs: string[]; commands: unknown[] }) => {
          h.submitted.push(input);
          return Promise.resolve({});
        },
      },
      commands: { orgIssueUnits: (cid: string, args: unknown) => ({ cid, args }) },
    } as never,
  });
  return Object.assign(h, { admin });
}

describe('HolderAdmin.issueUnits', () => {
  it('submits Org_IssueUnits as the treasurer, tells the holder and logs it', async () => {
    const h = harness();
    await h.admin.issueUnits({
      actor: TREASURER,
      holder: HOLDER,
      units: 1000,
      effectiveDate: '2026-05-01',
    });
    expect(h.submitted).toEqual([
      {
        actAs: [TREASURER],
        commands: [
          {
            cid: 'org',
            args: {
              registerCid: 'reg',
              holder: HOLDER,
              units: 1000,
              effectiveDate: '2026-05-01',
              seeded: false,
            },
          },
        ],
      },
    ]);
    expect(h.published).toEqual([
      { event: { type: 'holder', change: 'units' }, audience: { parties: [HOLDER] } },
    ]);
    expect(h.activity).toEqual([
      {
        actorParty: TREASURER,
        kind: 'units.issued',
        subject: HOLDER,
        text: 'Issued 1,000 units to Holder A',
      },
    ]);
  });

  it('defaults the date to today and tags seeded units on the ledger and in the log', async () => {
    const h = harness();
    await h.admin.issueUnits({ actor: TREASURER, holder: HOLDER, units: 5, seeded: true });
    const args = (
      h.submitted[0]?.commands[0] as { args: { effectiveDate: string; seeded: boolean } }
    ).args;
    expect(args).toMatchObject({ effectiveDate: '2026-10-01', seeded: true });
    expect(h.activity[0]?.seeded).toBe(true);
  });

  it('refuses a future date, a system party as holder, and a missing organization, before submitting', async () => {
    const h = harness();
    await expect(
      h.admin.issueUnits({
        actor: TREASURER,
        holder: HOLDER,
        units: 1,
        effectiveDate: '2026-10-02',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'future_date' });
    for (const holder of [
      config.parties.treasury,
      config.parties.agent,
      config.parties.operator,
      TREASURER,
    ]) {
      await expect(
        h.admin.issueUnits({ actor: TREASURER, holder, units: 1 }),
      ).rejects.toMatchObject({
        status: 400,
        code: 'invalid_holder',
      });
    }
    await expect(
      harness({ organization: false }).admin.issueUnits({
        actor: TREASURER,
        holder: HOLDER,
        units: 1,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'no_organization' });
    expect(h.submitted).toEqual([]);
  });
});

describe('HolderAdmin.createInvite', () => {
  it('stores the invite, refreshes party names, logs it and returns the link', async () => {
    const h = harness();
    const invite = await h.admin.createInvite({
      actor: TREASURER,
      kind: 'holder',
      displayName: 'Holder A',
      partyId: HOLDER,
    });
    expect(invite).toMatchObject({
      kind: 'holder',
      displayName: 'Holder A',
      orgName: 'Northwind',
      used: false,
      unitsOffered: null,
    });
    expect(invite.code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    expect(invite.path).toBe(`/invite/${invite.code}`);
    expect(h.invites[0]).toMatchObject({
      code: invite.code,
      partyId: HOLDER,
      createdBy: TREASURER,
    });
    expect(h.invalidated).toBe(1);
    expect(h.activity[0]).toMatchObject({ kind: 'invite.created', subject: invite.code });
  });

  it('tries another code when one is taken, and gives up after five', async () => {
    const retried = harness({ takenCodes: 2 });
    await retried.admin.createInvite({ actor: TREASURER, kind: 'auditor', displayName: 'Auditor' });
    expect(retried.invites).toHaveLength(1);
    expect(retried.invites[0]?.['partyId']).toBeNull();

    await expect(
      harness({ takenCodes: 5 }).admin.createInvite({
        actor: TREASURER,
        kind: 'holder',
        displayName: 'X',
      }),
    ).rejects.toMatchObject({ status: 500, code: 'invite_code_failed' });
  });
});
