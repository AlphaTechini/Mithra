import { and, eq } from 'drizzle-orm';
import type { Database } from '../db';
import { agentEvents, cycleRuns } from '../db/schema';

/** What the scheduler reads and writes in the database. */
export interface ScheduleStore {
  /** True when the cycle engine already has a `cycle_runs` row for this cycle. */
  hasRun(orgTreasury: string, cycleId: string): Promise<boolean>;
  hasEvent(cycleId: string, kind: string): Promise<boolean>;
  recordEvent(cycleId: string, kind: string, payload: Record<string, unknown>): Promise<void>;
}

export function createScheduleStore(db: Database): ScheduleStore {
  return {
    async hasRun(orgTreasury, cycleId) {
      const rows = await db
        .select({ id: cycleRuns.id })
        .from(cycleRuns)
        .where(and(eq(cycleRuns.orgTreasury, orgTreasury), eq(cycleRuns.cycleId, cycleId)))
        .limit(1);
      return rows.length > 0;
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
  runs: Set<string>;
  events: { cycleId: string; kind: string; payload: Record<string, unknown> }[];
} {
  const runs = new Set<string>();
  const events: { cycleId: string; kind: string; payload: Record<string, unknown> }[] = [];
  return {
    runs,
    events,
    hasRun: (orgTreasury, cycleId) => Promise.resolve(runs.has(`${orgTreasury}/${cycleId}`)),
    hasEvent: (cycleId, kind) =>
      Promise.resolve(events.some((e) => e.cycleId === cycleId && e.kind === kind)),
    recordEvent(cycleId, kind, payload) {
      events.push({ cycleId, kind, payload });
      return Promise.resolve();
    },
  };
}
