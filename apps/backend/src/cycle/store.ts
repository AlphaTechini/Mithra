import { TimelineStepSchema, type TimelineStep } from '@mithra/shared';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db';
import { agentEvents, cycleRuns, txRefs, type CycleRunRow } from '../db/schema';
import type { RunState } from './view';

export type RunStatus = CycleRunRow['status'];

export type RunPatch = Partial<
  Pick<
    CycleRunRow,
    | 'status'
    | 'error'
    | 'finishedAt'
    | 'trigger'
    | 'triggerDetail'
    | 'total'
    | 'recordDate'
    | 'executesAt'
    | 'held'
    | 'fundsShortfall'
    | 'startedAt'
  >
>;

export interface ReserveInput {
  cycleId: string;
  trigger: 'schedule' | 'prompt' | 'manual';
  triggerDetail: string;
  total: string | null;
  recordDate: string | null;
}

/** The funds shortfall as stored in `cycle_runs.funds_shortfall`. */
export interface Shortfall {
  balance: string;
  required: string;
}

/** The view of a run row the pure view functions use. */
export function runState(row: CycleRunRow): RunState {
  const raw = row.fundsShortfall as Partial<Shortfall> | null;
  return {
    status: row.status,
    startedAt: row.startedAt,
    error: row.error,
    trigger: row.trigger,
    total: row.total,
    recordDate: row.recordDate,
    executesAt: row.executesAt,
    held: row.held,
    fundsShortfall:
      raw && typeof raw.balance === 'string' && typeof raw.required === 'string'
        ? { balance: raw.balance, required: raw.required }
        : null,
  };
}

/**
 * `cycle_runs`, `agent_events` (the live timeline) and `tx_refs` for one treasury. State changes
 * that must not race (reserving a cycle, claiming an execution) are single compare-and-set
 * statements, so a second process or a restart cannot repeat them.
 */
export class CycleStore {
  constructor(
    private readonly db: Database,
    private readonly treasury: string,
  ) {}

  async get(cycleId: string): Promise<CycleRunRow | null> {
    const [row] = await this.db
      .select()
      .from(cycleRuns)
      .where(and(eq(cycleRuns.orgTreasury, this.treasury), eq(cycleRuns.cycleId, cycleId)))
      .limit(1);
    return row ?? null;
  }

  async list(): Promise<CycleRunRow[]> {
    return this.db
      .select()
      .from(cycleRuns)
      .where(eq(cycleRuns.orgTreasury, this.treasury))
      .orderBy(desc(cycleRuns.startedAt));
  }

  async withStatus(statuses: readonly RunStatus[]): Promise<CycleRunRow[]> {
    return this.db
      .select()
      .from(cycleRuns)
      .where(
        and(eq(cycleRuns.orgTreasury, this.treasury), inArray(cycleRuns.status, [...statuses])),
      );
  }

  /**
   * Reserves the cycle. The unique key (organization, cycle) is the double-run guard: of two
   * concurrent calls exactly one inserts (`created`), the other reads the existing row.
   */
  async reserve(input: ReserveInput): Promise<{ row: CycleRunRow; created: boolean }> {
    const [inserted] = await this.db
      .insert(cycleRuns)
      .values({
        orgTreasury: this.treasury,
        cycleId: input.cycleId,
        status: 'running',
        trigger: input.trigger,
        triggerDetail: input.triggerDetail,
        total: input.total,
        recordDate: input.recordDate,
      })
      .onConflictDoNothing({ target: [cycleRuns.orgTreasury, cycleRuns.cycleId] })
      .returning();
    if (inserted) return { row: inserted, created: true };
    const existing = await this.get(input.cycleId);
    if (!existing) throw new Error(`cycle_runs row for ${input.cycleId} vanished after a conflict`);
    return { row: existing, created: false };
  }

  /** Changes a row only when its status is one of `from` (compare and set). Null when it was not. */
  async transition(
    id: number,
    from: readonly RunStatus[],
    patch: RunPatch,
  ): Promise<CycleRunRow | null> {
    const [row] = await this.db
      .update(cycleRuns)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(cycleRuns.id, id), inArray(cycleRuns.status, [...from])))
      .returning();
    return row ?? null;
  }

  async patch(id: number, patch: RunPatch): Promise<CycleRunRow | null> {
    const [row] = await this.db
      .update(cycleRuns)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(cycleRuns.id, id))
      .returning();
    return row ?? null;
  }

  /** Keeps the row fresh while a long step runs, so it is not mistaken for a stale one. */
  async touch(id: number): Promise<void> {
    await this.db.update(cycleRuns).set({ updatedAt: new Date() }).where(eq(cycleRuns.id, id));
  }

  // Timeline ---------------------------------------------------------------------------------

  async addTimeline(cycleId: string, step: TimelineStep): Promise<void> {
    await this.db.insert(agentEvents).values({ cycleId, kind: 'timeline', payload: step });
  }

  /** Every timeline event of the cycle, oldest first. */
  async timeline(cycleId: string): Promise<TimelineStep[]> {
    const rows = await this.db
      .select({ payload: agentEvents.payload })
      .from(agentEvents)
      .where(and(eq(agentEvents.cycleId, cycleId), eq(agentEvents.kind, 'timeline')))
      .orderBy(asc(agentEvents.id));
    return rows.flatMap((r) => {
      const parsed = TimelineStepSchema.safeParse(r.payload);
      return parsed.success ? [parsed.data] : [];
    });
  }

  // Transaction references -------------------------------------------------------------------

  /** Remembers which update created a contract (for explorer and in-app links). */
  async setTxRef(contractId: string, updateId: string, kind: string): Promise<void> {
    await this.db
      .insert(txRefs)
      .values({ contractId, updateId, kind })
      .onConflictDoNothing({ target: [txRefs.contractId, txRefs.kind] });
  }

  /** Update ids by contract id for one kind. */
  async txRefsOf(contractIds: readonly string[], kind: string): Promise<Map<string, string>> {
    if (contractIds.length === 0) return new Map();
    const rows = await this.db
      .select({ contractId: txRefs.contractId, updateId: txRefs.updateId })
      .from(txRefs)
      .where(and(inArray(txRefs.contractId, [...contractIds]), eq(txRefs.kind, kind)));
    return new Map(rows.map((r) => [r.contractId, r.updateId]));
  }

  /** True when the (contract, kind) reference exists; used as a "done once" marker. */
  async hasTxRef(contractId: string, kind: string): Promise<boolean> {
    const rows = await this.db
      .select({ n: sql<number>`1` })
      .from(txRefs)
      .where(and(eq(txRefs.contractId, contractId), eq(txRefs.kind, kind)))
      .limit(1);
    return rows.length > 0;
  }
}
