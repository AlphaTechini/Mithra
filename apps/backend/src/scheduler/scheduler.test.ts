import type { MandateView } from '@mithra/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeServices, fakeMandate, type FakeServices } from '../agent/fakes';
import { EventBus } from '../events/bus';
import type { Ledger } from '../ledger';
import { previousMonthCycleId, startScheduler, type Scheduler } from './index';
import { createMemoryScheduleStore } from './store';

const TREASURY = 'treasury::1220aa';
const OCT_1 = new Date('2026-10-01T09:00:00Z');

function mandateWith(fixedAmount: string | null, cron = '0 9 1 * *', tz = 'UTC'): MandateView {
  const base = fakeMandate();
  return {
    ...base,
    terms: { ...base.terms, fixedAmount, scheduleCron: cron, scheduleTimezone: tz },
  };
}

interface Setup {
  scheduler: Scheduler;
  services: FakeServices;
  store: ReturnType<typeof createMemoryScheduleStore>;
  activity: { kind: string; text: string }[];
  executedCycles: string[];
}

const started: Scheduler[] = [];
afterEach(() => {
  for (const s of started.splice(0)) s.stop();
});

function setup(
  options: {
    mandate?: MandateView | null;
    store?: ReturnType<typeof createMemoryScheduleStore>;
    services?: FakeServices;
    now?: Date;
    rereadMs?: number;
  } = {},
): Setup {
  const services = options.services ?? createFakeServices();
  services.state.mandate = options.mandate === undefined ? mandateWith('1200') : options.mandate;
  const store = options.store ?? createMemoryScheduleStore();
  const activity: { kind: string; text: string }[] = [];
  const executedCycles: string[] = [];
  // Like the real engine, the fake records a cycle_runs row when a cycle starts.
  const run = services.cycles.run.bind(services.cycles);
  services.cycles.run = async (input) => {
    const result = await run(input);
    store.runs.add(`${TREASURY}/${result.cycleId}`);
    return result;
  };
  const scheduler = startScheduler({
    services,
    ledger: {
      reader: { mandate: () => Promise.resolve({ payload: { executedCycles } }) },
    } as unknown as Pick<Ledger, 'reader'>,
    store,
    bus: new EventBus(),
    treasuryParty: TREASURY,
    agentParty: 'agent::1220aa',
    activity: {
      record: (input) => {
        activity.push({ kind: input.kind, text: input.text });
        return Promise.resolve({} as never);
      },
    },
    now: () => options.now ?? OCT_1,
    ...(options.rereadMs ? { rereadMs: options.rereadMs } : {}),
  });
  started.push(scheduler);
  return { scheduler, services, store, activity, executedCycles };
}

describe('previousMonthCycleId', () => {
  it('is the month before the firing time, in the schedule time zone', () => {
    expect(previousMonthCycleId(new Date('2026-10-01T09:00:00Z'), 'UTC')).toBe('2026-09');
    expect(previousMonthCycleId(new Date('2027-01-01T09:00:00Z'), 'UTC')).toBe('2026-12');
    // 02:00 UTC on Oct 1 is still Sept 30 in New York.
    expect(previousMonthCycleId(new Date('2026-10-01T02:00:00Z'), 'America/New_York')).toBe(
      '2026-08',
    );
  });
});

describe('scheduler', () => {
  it("fires the previous month with the policy's fixed amount and the schedule trigger", async () => {
    const { scheduler, services } = setup();
    await scheduler.ready;
    const result = await scheduler.fireNow();
    expect(result).toEqual({ cycleId: '2026-09', outcome: 'started' });
    expect(services.runs).toEqual([
      {
        trigger: 'schedule',
        triggerDetail: 'Schedule 0 9 1 * * (UTC) for September 2026',
        cycleId: '2026-09',
        total: '1200',
        actorParty: 'agent::1220aa',
      },
    ]);
  });

  it('runs a cycle once even if fireNow is called twice, one after the other', async () => {
    const { scheduler, services } = setup();
    expect((await scheduler.fireNow()).outcome).toBe('started');
    expect((await scheduler.fireNow()).outcome).toBe('already-ran');
    expect(services.runs).toHaveLength(1);
  });

  it('runs a cycle once even if fireNow is called twice at the same moment', async () => {
    const { scheduler, services } = setup();
    const [a, b] = await Promise.all([scheduler.fireNow(), scheduler.fireNow()]);
    expect([a.outcome, b.outcome]).toEqual(['started', 'started']);
    expect(services.runs).toHaveLength(1);
  });

  it('runs a cycle once across a restart: a new scheduler finds the cycle_runs row', async () => {
    const store = createMemoryScheduleStore();
    const first = setup({ store });
    await first.scheduler.fireNow();
    first.scheduler.stop();

    const second = setup({ store });
    expect((await second.scheduler.fireNow()).outcome).toBe('already-ran');
    expect(second.services.runs).toEqual([]);
  });

  it('does not run a cycle the Mandate already executed (L3)', async () => {
    const { scheduler, services, executedCycles } = setup();
    executedCycles.push('2026-09');
    expect((await scheduler.fireNow()).outcome).toBe('already-ran');
    expect(services.runs).toEqual([]);
  });

  it('runs the next month as a new cycle', async () => {
    const { scheduler, services } = setup();
    await scheduler.fireNow(new Date('2026-10-01T09:00:00Z'));
    const next = await scheduler.fireNow(new Date('2026-11-01T09:00:00Z'));
    expect(next).toEqual({ cycleId: '2026-10', outcome: 'started' });
    expect(services.runs.map((r) => r.cycleId)).toEqual(['2026-09', '2026-10']);
  });

  it('does not guess an amount: it records an event and an activity entry, once per cycle', async () => {
    const { scheduler, services, store, activity } = setup({ mandate: mandateWith(null) });
    expect((await scheduler.fireNow()).outcome).toBe('no-amount');
    expect((await scheduler.fireNow()).outcome).toBe('no-amount');
    expect(services.runs).toEqual([]);
    const text =
      'Schedule fired for September 2026; no amount set. Tell the agent how much to distribute.';
    expect(store.events).toEqual([
      { cycleId: '2026-09', kind: 'schedule_no_amount', payload: { text, cron: '0 9 1 * *' } },
    ]);
    expect(activity).toEqual([{ kind: 'schedule.no_amount', text }]);
  });

  it('does nothing without a sealed Mandate', async () => {
    const { scheduler, services } = setup({ mandate: null });
    await scheduler.ready;
    expect((await scheduler.fireNow()).outcome).toBe('no-mandate');
    expect(scheduler.nextRun()).toBeNull();
    expect(services.runs).toEqual([]);
  });

  it('treats a unique-key refusal from the engine as "already ran"', async () => {
    const { scheduler, services } = setup();
    services.cycles.run = () =>
      Promise.reject(Object.assign(new Error('duplicate key'), { code: '23505' }));
    expect(await scheduler.fireNow()).toEqual({ cycleId: '2026-09', outcome: 'already-ran' });
    // Wrapped as the database driver does.
    services.cycles.run = () =>
      Promise.reject(
        new Error('Failed query', { cause: Object.assign(new Error('dup'), { code: '23505' }) }),
      );
    expect((await scheduler.fireNow()).outcome).toBe('already-ran');
  });

  it('records a failure and lets the next fire try again', async () => {
    const { scheduler, services, store, activity } = setup();
    const original = services.cycles.run.bind(services.cycles);
    services.cycles.run = () => Promise.reject(new Error('ledger down'));
    const failed = await scheduler.fireNow();
    expect(failed).toMatchObject({ cycleId: '2026-09', outcome: 'failed', error: 'ledger down' });
    expect(store.events.map((e) => e.kind)).toEqual(['schedule_failed']);
    expect(activity[0]?.kind).toBe('schedule.failed');
    services.cycles.run = original;
    expect((await scheduler.fireNow()).outcome).toBe('started');
  });

  it('fires from its cron job and still runs the cycle only once', async () => {
    // Every second: many fires inside the wait, one cycle (the previous month is the same each time).
    const { scheduler, services } = setup({
      mandate: mandateWith('1200', '* * * * * *'),
      now: undefined,
    });
    await scheduler.ready;
    expect(scheduler.nextRun()).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 2600));
    expect(services.runs).toHaveLength(1);
    expect(services.runs[0]).toMatchObject({ trigger: 'schedule', total: '1200' });
  });

  it("reschedules when the Mandate's cron changes and ignores an invalid one", async () => {
    const { scheduler, services } = setup({ mandate: mandateWith('1200', '0 9 1 * *') });
    await scheduler.ready;
    const first = scheduler.nextRun();
    expect(first?.getUTCDate()).toBe(1);
    services.state.mandate = mandateWith('1200', '30 14 15 * *');
    await scheduler.refresh();
    const second = scheduler.nextRun();
    expect(second?.getUTCDate()).toBe(15);
    expect(second?.getUTCHours()).toBe(14);
    services.state.mandate = mandateWith('1200', 'not a cron');
    await scheduler.refresh();
    expect(scheduler.nextRun()).toBeNull();
  });
});
