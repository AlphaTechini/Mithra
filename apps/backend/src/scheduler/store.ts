import { and, eq } from 'drizzle-orm';
import type { Database } from '../db';
import { agentEvents, cycleRuns, type CycleRunRow } from '../db/schema';

/**
 * Run statuses after which a cycle may be started again: the run failed, or its proposal was
 * rejected or cancelled (`CycleService.run` starts a new attempt on the same row). Every other
 * status is a run in progress (running, proposed, held, executing) or an executed one.
 */
export const RETRYABLE_RUN_STATUSES = [
  'failed',
  'rejected',
  'cancelled',
] as const satisfies readonly CycleRunRow['status'][];

function blocksNewRun(status: CycleRunRow['status']): boolean {
  return !(RETRYABLE_RUN_STATUSES as readonly string[]).includes(status);
}

/** What the scheduler reads and writes in the database. */
export interface ScheduleStore {
  /**
   * True when the cycle engine has a `cycle_runs` row for this cycle that is active or executed.
   * A failed, rejected or cancelled run does not count: the schedule may try the cycle again.
   */
  hasBlockingRun(orgTreasury: string, cycleId: string): Promise<boolean>;
  hasEvent(cycleId: string, kind: string): Promise<boolean>;
  recordEvent(cycleId: string, kind: string, payload: Record<string, unknown>): Promise<void>;
}

export function createScheduleStore(db: Database): ScheduleStore {
  return {
    async hasBlockingRun(orgTreasury, cycleId) {
      const rows = await db
        .select({ status: cycleRuns.status })
        .from(cycleRuns)
        .where(and(eq(cycleRuns.orgTreasury, orgTreasury), eq(cycleRuns.cycleId, cycleId)))
        .limit(1);
      return rows.some((row) => blocksNewRun(row.status));
    },
    async hasEvent(cycleId, kind) {
      const rows = await db
        .select({ id: agentEvents.id })
        .from(agentEvents)
        .where(and(eq(agentEvents.cycleId, cycleId), eq(agentEvents.kind, kind)))
        .limit(1);
      return rows.length > 0;
    },
    async recordEvent(cycleId, kind, payload) {
      await db.insert(agentEvents).values({ cycleId, kind, payload });
    },
  };
}

/** In memory, for unit tests. Share one between two schedulers to simulate a restart. */
export function createMemoryScheduleStore(): ScheduleStore & {
  /** `<treasury>/<cycle id>` to the status of its `cycle_runs` row. */
  runs: Map<string, CycleRunRow['status']>;
  events: { cycleId: string; kind: string; payload: Record<string, unknown> }[];
} {
  const runs = new Map<string, CycleRunRow['status']>();
  const events: { cycleId: string; kind: string; payload: Record<string, unknown> }[] = [];
  return {
    runs,
    events,
    hasBlockingRun: (orgTreasury, cycleId) => {
      const status = runs.get(`${orgTreasury}/${cycleId}`);
      return Promise.resolve(status !== undefined && blocksNewRun(status));
    },
    hasEvent: (cycleId, kind) =>
      Promise.resolve(events.some((e) => e.cycleId === cycleId && e.kind === kind)),
    recordEvent(cycleId, kind, payload) {
      events.push({ cycleId, kind, payload });
      return Promise.resolve();
    },
  };
}
