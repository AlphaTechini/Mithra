import { EventBus, type Published } from '../events/bus';
import { describe, expect, it } from 'vitest';
import type { Ledger } from './../ledger';
import type { AccessGrant, Contract } from '../ledger';
import { startGrantExpiry } from './expiry';

function grant(id: string, expiresAt: string): Contract<AccessGrant> {
  return {
    contractId: `cid-${id}`,
    createdAt: '2026-10-01T00:00:00Z',
    payload: {
      treasury: 'treasury::1',
      treasurer: 'treasurer::1',
      agent: 'agent::1',
      auditor: 'auditor::1',
      grantId: id,
      requestId: `req-${id}`,
      question: 'q',
      recordIds: ['a'],
      sharedCids: ['s1'],
      grantedAt: '2026-10-01T00:00:00Z',
      expiresAt,
    },
  };
}

function fakeLedger(grants: Contract<AccessGrant>[], options: { failFor?: string } = {}) {
  const submitted: {
    actAs: string[];
    readAs?: string[];
    choice: string;
    cid: string;
    closer: string;
  }[] = [];
  const open = [...grants];
  const ledger = {
    reader: { grants: () => Promise.resolve([...open]) },
    commands: {
      accessGrantCloseExpired: (cid: string, args: { closer: string }) => ({
        ExerciseCommand: {
          templateId: 'T',
          contractId: cid,
          choice: 'AccessGrant_CloseExpired',
          choiceArgument: { closer: args.closer },
        },
      }),
    },
    client: {
      submit: (input: {
        actAs: string[];
        readAs?: string[];
        commands: {
          ExerciseCommand: {
            contractId: string;
            choice: string;
            choiceArgument: { closer: string };
          };
        }[];
      }) => {
        const command = input.commands[0]?.ExerciseCommand;
        if (command?.contractId === options.failFor)
          return Promise.reject(new Error('already closed'));
        submitted.push({
          actAs: input.actAs,
          ...(input.readAs ? { readAs: input.readAs } : {}),
          choice: command?.choice ?? '',
          cid: command?.contractId ?? '',
          closer: command?.choiceArgument.closer ?? '',
        });
        const index = open.findIndex((g) => g.contractId === command?.contractId);
        if (index >= 0) open.splice(index, 1);
        return Promise.resolve({});
      },
    },
  };
  return { ledger: ledger as unknown as Pick<Ledger, 'reader' | 'client' | 'commands'>, submitted };
}

function setup(
  grants: Contract<AccessGrant>[],
  options: { failFor?: string; now?: Date; intervalMs?: number } = {},
) {
  const { ledger, submitted } = fakeLedger(grants, options);
  const bus = new EventBus();
  const published: Published[] = [];
  bus.subscribe((p) => published.push(p));
  const activity: { kind: string; text: string; actorParty: string }[] = [];
  const expiry = startGrantExpiry({
    ledger,
    bus,
    names: { name: (id) => Promise.resolve(id === 'auditor::1' ? 'Audit Firm' : id) },
    activity: {
      record: (input) => {
        activity.push({ kind: input.kind, text: input.text, actorParty: input.actorParty });
        return Promise.resolve({} as never);
      },
    },
    intervalMs: options.intervalMs ?? 60_000,
    readAs: ['treasury::1'],
    now: () => options.now ?? new Date('2026-10-08T12:00:00Z'),
  });
  return { expiry, submitted, published, activity };
}

describe('grant expiry', () => {
  it('closes only expired grants, as the agent, and logs and publishes it', async () => {
    const { expiry, submitted, published, activity } = setup([
      grant('g-old', '2026-10-08T11:59:59Z'),
      grant('g-edge', '2026-10-08T12:00:00Z'),
      grant('g-later', '2026-10-09T00:00:00Z'),
    ]);
    const run = await expiry.closeExpiredNow();
    expiry.stop();
    expect(run).toEqual({ closed: 2, failed: 0, grants: ['g-old', 'g-edge'] });
    expect(submitted.map((s) => s.cid)).toEqual(['cid-g-old', 'cid-g-edge']);
    for (const s of submitted) {
      expect(s).toMatchObject({
        actAs: ['agent::1'],
        readAs: ['treasury::1'],
        choice: 'AccessGrant_CloseExpired',
        closer: 'agent::1',
      });
    }
    expect(activity[0]).toEqual({
      kind: 'grant.closed',
      text: 'Access for Audit Firm ended 2026-10-08 (expired)',
      actorParty: 'agent::1',
    });
    expect(published).toHaveLength(2);
    expect(published[0]).toEqual({
      event: { type: 'audit', requestId: 'req-g-old' },
      audience: { parties: ['treasurer::1', 'auditor::1'] },
    });
  });

  it('does nothing when nothing has expired', async () => {
    const { expiry, submitted } = setup([grant('g', '2026-10-09T00:00:00Z')]);
    expect(await expiry.closeExpiredNow()).toEqual({ closed: 0, failed: 0, grants: [] });
    expiry.stop();
    expect(submitted).toEqual([]);
  });

  it('keeps going when one grant cannot be closed and counts it as failed', async () => {
    const { expiry, submitted } = setup(
      [grant('g1', '2026-10-01T00:00:00Z'), grant('g2', '2026-10-01T00:00:00Z')],
      { failFor: 'cid-g1' },
    );
    const run = await expiry.closeExpiredNow();
    expiry.stop();
    expect(run).toEqual({ closed: 1, failed: 1, grants: ['g2'] });
    expect(submitted.map((s) => s.cid)).toEqual(['cid-g2']);
  });

  it('checks on a timer, well within 5 minutes by default', async () => {
    const { expiry, submitted } = setup([grant('g', '2026-10-01T00:00:00Z')], { intervalMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expiry.stop();
    expect(submitted.map((s) => s.cid)).toEqual(['cid-g']);
  });

  it('shares one run between concurrent callers', async () => {
    const { expiry, submitted } = setup([grant('g', '2026-10-01T00:00:00Z')]);
    const [a, b] = await Promise.all([expiry.closeExpiredNow(), expiry.closeExpiredNow()]);
    expiry.stop();
    expect(a).toBe(b);
    expect(submitted).toHaveLength(1);
  });
});
