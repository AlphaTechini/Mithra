import { Cron } from 'croner';
import type { ActivityLog } from '../activity/log';
import { cycleLabelOf } from '../agent/format';
import type { AgentServices } from '../agent/services';
import type { Database } from '../db';
import type { EventBus } from '../events/bus';
import type { Ledger } from '../ledger';
import { createScheduleStore, type ScheduleStore } from './store';

export interface SchedulerDeps {
  services: AgentServices;
  /** For the cycles the Mandate already executed (L3), as a second guard next to `cycle_runs`. */
  ledger: Pick<Ledger, 'reader'>;
  /** The application database; used for the default store. */
  db?: Database;
  /** Overrides the database store (unit tests). */
  store?: ScheduleStore;
  bus: EventBus;
  /** The treasury party: the `org_treasury` of `cycle_runs`. */
  treasuryParty: string;
  /** The agent's party, shown as the actor of schedule entries. */
  agentParty: string;
  activity?: Pick<ActivityLog, 'record'>;
  now?: () => Date;
  /** How often the Mandate is read again for a changed schedule. Default 5 minutes. */
  rereadMs?: number;
  log?: {
    warn(object: unknown, message?: string): void;
    info?(object: unknown, message?: string): void;
  };
}

export type FireOutcome =
  | 'started'
  /** An active or executed `cycle_runs` row, or the Mandate, already has this cycle: nothing was started. */
  | 'already-ran'
  /** The policy has no fixed amount; the agent asked the treasurer for one. */
  | 'no-amount'
  | 'no-mandate'
  | 'failed';

export interface FireResult {
  cycleId: string;
  outcome: FireOutcome;
  error?: string;
}

export interface Scheduler {
  /** Fires the schedule as if the cron time had come. Calling it twice never runs a cycle twice. */
  fireNow(at?: Date): Promise<FireResult>;
  /** Reads the Mandate and (re)schedules the job if the cron or time zone changed. */
  refresh(): Promise<void>;
  /** Resolves once the first read of the Mandate is done. */
  ready: Promise<void>;
  /** Next time the job will fire, or null when there is no Mandate or schedule. */
  nextRun(): Date | null;
  stop(): void;
}

/** `2026-10-01` in `timeZone` -> `2026-09`: the cycle a schedule that fires on the 1st pays. */
export function previousMonthCycleId(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(at);
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  return `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current === 'object' && (current as { code?: unknown }).code === '23505')
      return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function resolveStore(deps: Pick<SchedulerDeps, 'store' | 'db'>): ScheduleStore {
  if (deps.store) return deps.store;
  if (deps.db) return createScheduleStore(deps.db);
  throw new Error('startScheduler needs a db or a store');
}

export function startScheduler(deps: SchedulerDeps): Scheduler {
  const store = resolveStore(deps);
  const now = deps.now ?? ((): Date => new Date());
  const rereadMs = deps.rereadMs ?? 5 * 60_000;
  const inFlight = new Map<string, Promise<FireResult>>();
  let job: Cron | null = null;
  let scheduled = '';
  let stopped = false;

  async function alreadyRan(cycleId: string): Promise<boolean> {
    if (await store.hasBlockingRun(deps.treasuryParty, cycleId)) return true;
    const mandate = await deps.ledger.reader.mandate();
    return mandate?.payload.executedCycles.includes(cycleId) ?? false;
  }

  async function fire(at: Date): Promise<FireResult> {
    const mandate = await deps.services.org.mandate();
    if (!mandate) return { cycleId: '', outcome: 'no-mandate' };
    const { scheduleCron, scheduleTimezone, fixedAmount } = mandate.terms;
    const cycleId = previousMonthCycleId(at, scheduleTimezone);
    const label = cycleLabelOf(cycleId);

    if (await alreadyRan(cycleId)) return { cycleId, outcome: 'already-ran' };

    if (fixedAmount === null) {
      // The agent never guesses an amount: it asks, once per cycle.
      const noted = await store.hasEvent(cycleId, 'schedule_no_amount');
      if (!noted) {
        const text = `Schedule fired for ${label}; no amount set. Tell the agent how much to distribute.`;
        await store.recordEvent(cycleId, 'schedule_no_amount', { text, cron: scheduleCron });
        await deps.activity
          ?.record({
            actorParty: deps.agentParty,
            kind: 'schedule.no_amount',
            subject: cycleId,
            text,
            link: '/app/agent',
          })
          .catch((error: unknown) =>
            deps.log?.warn({ err: error }, 'could not log the schedule entry'),
          );
      }
      return { cycleId, outcome: 'no-amount' };
    }

    try {
      await deps.services.cycles.run({
        trigger: 'schedule',
        triggerDetail: `Schedule ${scheduleCron} (${scheduleTimezone}) for ${label}`,
        cycleId,
        total: fixedAmount,
        actorParty: deps.agentParty,
      });
    } catch (error) {
      // The unique key of cycle_runs is the final guard: a second run of the same cycle is refused there.
      if (isUniqueViolation(error)) {
        return { cycleId, outcome: 'already-ran' };
      }
      const message = error instanceof Error ? error.message : String(error);
      deps.log?.warn({ err: error, cycleId }, 'scheduled cycle failed to start');
      await store
        .recordEvent(cycleId, 'schedule_failed', { error: message })
        .catch(() => undefined);
      await deps.activity
        ?.record({
          actorParty: deps.agentParty,
          kind: 'schedule.failed',
          subject: cycleId,
          text: `Schedule fired for ${label} but the cycle could not start. Use Run cycle now, or check the ledger connection.`,
          link: '/app/cycles',
        })
        .catch(() => undefined);
      return { cycleId, outcome: 'failed', error: message };
    }
    await store
      .recordEvent(cycleId, 'schedule_started', { cron: scheduleCron, total: fixedAmount })
      .catch(() => undefined);
    return { cycleId, outcome: 'started' };
  }

  function fireNow(at: Date = now()): Promise<FireResult> {
    // Two calls at the same moment share one run.
    const key = `${at.toISOString().slice(0, 7)}`;
    const existing = inFlight.get(key);
    if (existing) return existing;
    const run = fire(at).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, run);
    return run;
  }

  async function refresh(): Promise<void> {
    if (stopped) return;
    let mandate;
    try {
      mandate = await deps.services.org.mandate();
    } catch (error) {
      deps.log?.warn(
        { err: error },
        'scheduler could not read the Mandate; keeping the current schedule',
      );
      return;
    }
    // stop() may have run while the Mandate was being read: do not start a job after shutdown.
    if (stopped) return;
    const wanted = mandate ? `${mandate.terms.scheduleCron}|${mandate.terms.scheduleTimezone}` : '';
    if (wanted === scheduled) return;
    job?.stop();
    job = null;
    scheduled = wanted;
    if (!mandate) return;
    try {
      job = new Cron(
        mandate.terms.scheduleCron,
        {
          timezone: mandate.terms.scheduleTimezone,
          protect: true,
          catch: (error: unknown) => deps.log?.warn({ err: error }, 'scheduled run failed'),
        },
        () => {
          void fireNow().catch((error: unknown) =>
            deps.log?.warn({ err: error }, 'scheduled run failed'),
          );
        },
      );
      deps.log?.info?.({ cron: mandate.terms.scheduleCron }, 'schedule set');
    } catch (error) {
      scheduled = '';
      deps.log?.warn({ err: error }, 'the Mandate schedule is not a valid cron expression');
    }
  }

  const ready = refresh();
  const timer = setInterval(() => {
    void refresh();
  }, rereadMs);
  timer.unref();

  return {
    fireNow,
    refresh,
    ready,
    nextRun: () => job?.nextRun() ?? null,
    stop() {
      stopped = true;
      clearInterval(timer);
      job?.stop();
      job = null;
    },
  };
}
