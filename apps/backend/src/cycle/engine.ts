import {
  formatDecimal,
  toDecimal,
  type ApprovalsInbox,
  type CycleDetail,
  type CycleSummary,
  type DecisionRecordView,
  type TimelineStep,
} from '@mithra/shared';
import type { Config } from '../config/env';
import type { Database } from '../db';
import type { CycleRunRow } from '../db/schema';
import { ApiError } from '../http/errors';
import {
  choiceResults,
  createdIn,
  DistributionOutcomeSchema,
  LedgerError,
  ProposalSchema,
  type Contract,
  type Fingerprint,
  type Ledger,
  type Mandate,
  type Payout,
  type Proposal,
  type ProposalInput,
  type Transaction,
} from '../ledger';
import type { ActivityLog } from '../activity/log';
import { TREASURY_TEAM, type EventBus } from '../events/bus';
import { shortPartyId, type PartyNames } from '../parties/names';
import type { MainnetWalletLookup } from '../mainnet/wallets';
import { RegistryError, type AssetAdapter } from '../wallet';
import { runChecks, type CheckTrigger, type HistoryEntry, selectHistory } from './checks';
import { AgentPayoutExecutor, type PayoutExecutor } from './executor';
import { fingerprint, sha256Hex } from './fingerprint';
import { D, cycleLabel as labelOf, formatAmount, monthName, plural, shortDate } from './format';
import { txLinkFor } from './links';
import {
  TemplateMemoWriter,
  sanitizeAdvisoryChecks,
  type MemoInput,
  type MemoResult,
  type MemoWriter,
} from './memo';
import { Mutex } from './mutex';
import { GroftyMainnetRail, LedgerPayoutRail, type PayoutRail, type RailResult } from './rail';
import {
  cycleIdForRun,
  defaultCycleId,
  isCycleId,
  isoDateOf,
  nextRun,
  recordDateFor,
  recordDateProblem,
  addDays,
  type RecordDateRule,
} from './period';
import { ProRataError, computeProRata, unitsAt } from './prorata';
import { CycleStore, runState, type RunStatus, type Shortfall } from './store';
import {
  currentTimeline,
  decisionRecordView,
  detailOf,
  groupCycles,
  inboxOf,
  partiesOf,
  summaryOf,
  validApprovalCount,
  type CycleFacts,
  type LedgerFacts,
  type RunState,
  type ViewContext,
} from './view';

export interface RunInput {
  trigger: CheckTrigger;
  /** One line for the timeline and the decision record, e.g. "Run cycle now by Treasurer". */
  triggerDetail: string;
  /** `YYYY-MM`; default: the previous calendar month (UTC). */
  cycleId?: string;
  /** Decimal string; default: the policy's fixed amount. */
  total?: string;
  /** `YYYY-MM-DD`; default: by the policy's record date rule. */
  recordDate?: string;
  /** The prompt that asked for this cycle (fingerprinted, A12). */
  promptText?: string;
  /** Fingerprints of the agent conversation turn that asked for the cycle (A12). */
  modelFingerprints?: Fingerprint[];
  /** The party that asked: the treasurer, or the agent for a scheduled run. */
  actorParty: string;
  /** Marks the cycle as demo history: the decision record, outcome and payments carry `seeded`. */
  seeded?: boolean;
}

/** What `advance` did, for the reconciler. */
export type AdvanceResult =
  | 'executed'
  | 'needs-funds'
  | 'waiting'
  | 'busy'
  | 'retry'
  | 'failed'
  /** MainNet: authorized on the ledger; the treasurer signs the payouts in Grofty. */
  | 'awaiting-signature'
  /** MainNet: some payees have not connected Grofty Wallet. */
  | 'needs-wallets'
  | 'idle';

export interface NextCycle {
  cycleId: string;
  label: string;
  at: string;
}

/** The reads other modules (the overview route) need. */
export interface CycleQueries {
  listCycles(): Promise<CycleSummary[]>;
  nextCycle(): Promise<NextCycle | null>;
}

export interface CycleService extends CycleQueries {
  /**
   * Starts a cycle and returns at once with its id; the steps run in the background and are
   * published as timeline events. A second call for the same cycle returns the same id (the unique
   * key in `cycle_runs` is the double-run guard); a cycle whose run failed or whose proposal was
   * rejected or cancelled starts a new attempt.
   */
  run(input: RunInput): Promise<{ cycleId: string }>;
  /** Pays the proposal of a cycle that is ready (countdown over and not held, or approved). */
  execute(cycleId: string): Promise<CycleDetail>;
  hold(cycleId: string, actorParty: string): Promise<CycleDetail>;
  release(cycleId: string, actorParty: string): Promise<CycleDetail>;
  cancel(cycleId: string, actorParty: string): Promise<CycleDetail>;
  approve(proposalId: string, approverParty: string, note: string): Promise<CycleDetail>;
  reject(proposalId: string, approverParty: string, reason: string): Promise<CycleDetail>;
  getCycle(cycleId: string): Promise<CycleDetail>;
  inbox(approverParty: string): Promise<ApprovalsInbox>;
  decisionRecord(recordId: string): Promise<DecisionRecordView>;
  /** One reconciler pass over one cycle: executes it when it is ready. */
  advance(cycleId: string): Promise<AdvanceResult>;
  /** Cycle ids with a proposal that is waiting (countdown, held, approvals or funds). */
  waitingCycleIds(): Promise<string[]>;
  /** Frees runs and submissions that a crash left half done. */
  recoverStale(): Promise<void>;
  /** Resolves when every background run and execution started so far has finished (tests). */
  settled(): Promise<void>;
  /** Stops the Hold timers. */
  dispose(): void;
}

export interface CycleDeps {
  config: Config;
  db: Database;
  ledger: Pick<Ledger, 'client' | 'reader' | 'commands'>;
  assets: AssetAdapter;
  names: PartyNames;
  activity: ActivityLog;
  bus: EventBus;
  /** The memo writer; default: the template writer. The AI writer (M5) plugs in here. */
  memoWriter?: MemoWriter;
  /** Seconds of the Hold countdown; default `config.holdCountdownSeconds` or 30 (U6). */
  holdCountdownSeconds?: number;
  /** Replaces the clock (tests). */
  now?: () => Date;
  /** Run the Hold countdown timers; the reconciler is the backstop. Default true. */
  timers?: boolean;
  /** Replaces the agent payout executor of the ledger rail (tests). */
  agentExecutor?: PayoutExecutor;
  /** MainNet payouts: the holders' registered Grofty wallets. Required on MainNet. */
  wallets?: MainnetWalletLookup;
  /** Replaces the payout rail (tests); default: by network. */
  rail?: PayoutRail;
  /** How long a payout may take on the ledger. Default 10 minutes. */
  executeWindowMs?: number;
}

const DEFAULT_COUNTDOWN_SECONDS = 30;
const EXECUTE_WINDOW_MS = 10 * 60 * 1000;
/** A `running` row older than this with no live run in this process is a crashed run. */
const STALE_RUN_MS = 5 * 60 * 1000;
/** An `executing` row older than this with no live execution in this process is retried. */
const STALE_EXECUTION_MS = 3 * 60 * 1000;

const TRIGGER_ENUM = {
  schedule: 'TriggerSchedule',
  prompt: 'TriggerPrompt',
  manual: 'TriggerManual',
} as const;

type StepId = TimelineStep['id'];

const STEP_LABELS: Record<StepId, string> = {
  woke: 'Woke up',
  snapshot: 'Snapshot taken',
  amounts: 'Amounts computed',
  checks: 'Checks run',
  review: 'Review written',
  verdict: 'Verdict',
  execute: 'Payments',
};

/** A failure of one pipeline step, with the message people see on the timeline. */
class StepError extends Error {
  constructor(
    readonly step: StepId,
    message: string,
  ) {
    super(message);
    this.name = 'StepError';
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The attempt number the ledger accepts next for a cycle: one more than the newest on the Mandate. */
export function nextAttempt(mandate: Mandate, cycleId: string): number {
  const last = mandate.cycleAttempts.find((a) => a.cycleId === cycleId)?.attempt ?? 0;
  return last + 1;
}

/** True for ledger errors that say the contract used in the command is no longer active. */
function isStaleContract(error: unknown): boolean {
  if (!(error instanceof LedgerError)) return false;
  const text = `${error.code} ${error.rawCause ?? ''} ${error.message}`;
  return /CONTRACT_NOT_FOUND|could not be found|not active|inactive contract/i.test(text);
}

/**
 * True when nothing definite is known: the ledger or the registry did not answer, or reported a
 * transient failure. The payout is tried again later (the command id keeps that safe).
 */
export function isTransient(error: unknown): boolean {
  if (error instanceof LedgerError) return error.status === 0 || error.retryable;
  if (error instanceof RegistryError) return error.status === 0 || error.status >= 500;
  return false;
}

const HISTORY_KINDS = new Set(['Executed']);

export function createCycleService(deps: CycleDeps): CycleService {
  return new CycleEngine(deps);
}

class CycleEngine implements CycleService {
  private readonly treasury: string;
  private readonly agent: string;
  private readonly symbol: string;
  private readonly store: CycleStore;
  private readonly memoWriter: MemoWriter;
  private readonly now: () => Date;
  private readonly countdownMs: number;
  private readonly executeWindowMs: number;
  private readonly timersOn: boolean;
  private readonly rail: PayoutRail;
  /** `needs-wallets` activity already recorded by this process, so a retry does not repeat it. */
  private readonly walletsNoted = new Map<string, string>();
  /** Serializes submissions that consume or read the Mandate, so they do not race each other. */
  private readonly mandateLock = new Mutex();
  /** Background pipelines and executions started by this instance, by cycle id. */
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: CycleDeps) {
    this.treasury = deps.config.parties.treasury;
    this.agent = deps.config.parties.agent;
    this.symbol = deps.config.asset.symbol;
    this.store = new CycleStore(deps.db, this.treasury);
    this.memoWriter = deps.memoWriter ?? new TemplateMemoWriter();
    this.now = deps.now ?? (() => new Date());
    const seconds =
      deps.holdCountdownSeconds ?? deps.config.holdCountdownSeconds ?? DEFAULT_COUNTDOWN_SECONDS;
    this.countdownMs = Math.max(seconds, 0) * 1000;
    this.executeWindowMs = deps.executeWindowMs ?? EXECUTE_WINDOW_MS;
    this.timersOn = deps.timers ?? true;
    this.rail = deps.rail ?? this.defaultRail();
  }

  private defaultRail(): PayoutRail {
    const { deps } = this;
    const lock = <T>(fn: () => Promise<T>): Promise<T> => this.mandateLock.run(fn);
    if (deps.config.network === 'mainnet') {
      if (!deps.wallets) {
        throw new Error("MainNet payouts need the holders' wallets (CycleDeps.wallets).");
      }
      return new GroftyMainnetRail({
        ledger: deps.ledger,
        agent: this.agent,
        readAs: this.readAs(),
        wallets: deps.wallets,
        lock,
      });
    }
    return new LedgerPayoutRail({
      assets: deps.assets,
      executor:
        deps.agentExecutor ??
        new AgentPayoutExecutor(
          deps.ledger,
          { agent: this.agent, treasury: this.treasury },
          deps.config.ledger.readAsTreasury,
        ),
      treasury: this.treasury,
      executeWindowMs: this.executeWindowMs,
      now: this.now,
      lock,
    });
  }

  // ---------------------------------------------------------------------------------------
  // Small helpers

  private readAs(): string[] {
    return this.deps.config.ledger.readAsTreasury ? [this.treasury] : [];
  }

  private track<T>(cycleId: string, promise: Promise<T>): Promise<T> {
    const tracked = promise.finally(() => {
      if (this.inflight.get(cycleId) === tracked) this.inflight.delete(cycleId);
    });
    this.inflight.set(cycleId, tracked);
    return tracked;
  }

  settled(): Promise<void> {
    const wait = async (): Promise<void> => {
      for (let guard = 0; guard < 100; guard += 1) {
        const pending = [...this.inflight.values()];
        if (pending.length === 0) return;
        await Promise.allSettled(pending);
      }
    };
    return wait();
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private async step(
    cycleId: string,
    id: StepId,
    status: TimelineStep['status'],
    detail: string | null,
    label: string = STEP_LABELS[id],
  ): Promise<void> {
    const step: TimelineStep = { id, label, status, detail, at: this.now().toISOString() };
    await this.store.addTimeline(cycleId, step);
    this.deps.bus.publish({ type: 'timeline', cycleId, step }, TREASURY_TEAM);
  }

  /** Publishes the cycle's current status; never throws (a missed live update is harmless). */
  private async emitStatus(cycleId: string): Promise<void> {
    try {
      const detail = await this.getCycle(cycleId);
      this.deps.bus.publish(
        { type: 'cycle', cycleId, status: detail.summary.status },
        TREASURY_TEAM,
      );
    } catch {
      // The next change publishes again.
    }
  }

  private async record(
    actor: string,
    kind: string,
    cycleId: string,
    text: string,
    detail?: Record<string, unknown>,
    /** Whether the cycle is demo history (U8). Looked up on the ledger when the caller does not know. */
    seeded?: boolean,
  ): Promise<void> {
    try {
      const isSeeded = seeded ?? (await this.seededOnLedger(cycleId));
      await this.deps.activity.record({
        actorParty: actor,
        kind,
        subject: cycleId,
        text,
        link: `/app/cycles/${cycleId}`,
        ...(isSeeded ? { seeded: true } : {}),
        ...(detail ? { detail } : {}),
      });
    } catch {
      // The activity log is a convenience view; the ledger holds the truth.
    }
  }

  /** True when the cycle's open proposal on the ledger was made as seeded demo history. */
  private async seededOnLedger(cycleId: string): Promise<boolean> {
    const proposals = await this.deps.ledger.reader.proposals();
    return proposals.some((p) => p.payload.cycleId === cycleId && p.payload.seeded);
  }

  private async nameOf(party: string): Promise<string> {
    return this.deps.names.name(party);
  }

  // ---------------------------------------------------------------------------------------
  // Ledger snapshot and views

  private async loadLedger(): Promise<LedgerFacts> {
    const { reader } = this.deps.ledger;
    const [mandate, proposals, records, outcomes, payments] = await Promise.all([
      reader.mandate(),
      reader.proposals(),
      reader.decisionRecords(),
      reader.outcomes(),
      reader.payments(),
    ]);
    return { mandate, proposals, records, outcomes, payments };
  }

  private async snapshot(): Promise<{
    ledger: LedgerFacts;
    cycles: CycleFacts[];
    ctx: ViewContext;
  }> {
    const [ledger, rowList, wallets] = await Promise.all([
      this.loadLedger(),
      this.store.list(),
      this.rail.kind === 'grofty-mainnet' && this.deps.wallets
        ? this.deps.wallets.all()
        : Promise.resolve(null),
    ]);
    const rows = new Map<string, RunState>(rowList.map((r) => [r.cycleId, runState(r)]));
    const cycles = groupCycles(rows, ledger);
    if (wallets) {
      // MainNet: who of the active proposal's payees still has to connect Grofty Wallet.
      for (const cf of cycles) {
        cf.missingWallets = (cf.proposal?.payload.payouts ?? [])
          .map((p) => p.holder)
          .filter((holder) => !wallets.has(holder));
      }
    }
    const parties = partiesOf(cycles);
    const refs = new Map(
      await Promise.all([...parties].map(async (p) => [p, await this.deps.names.ref(p)] as const)),
    );
    const contractIds: string[] = [];
    for (const cf of cycles) {
      for (const p of cf.payments) contractIds.push(p.contractId);
      for (const ref of cf.outcome?.payload.payments ?? []) contractIds.push(ref.paymentCid);
    }
    const updates = await this.store.txRefsOf(contractIds, 'payment');
    const ctx: ViewContext = {
      now: this.now(),
      assetSymbol: this.symbol,
      refOf: (partyId) => refs.get(partyId) ?? { partyId, displayName: shortPartyId(partyId) },
      updateIdOf: (contractId) => updates.get(contractId) ?? null,
      linkFor: (updateId) => txLinkFor(this.deps.config, updateId),
    };
    return { ledger, cycles, ctx };
  }

  async listCycles(): Promise<CycleSummary[]> {
    const { ledger, cycles, ctx } = await this.snapshot();
    return cycles
      .map((cf) => summaryOf(cf, ledger.mandate, ctx))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  async getCycle(cycleId: string): Promise<CycleDetail> {
    const { ledger, cycles, ctx } = await this.snapshot();
    const cf = cycles.find((c) => c.cycleId === cycleId);
    if (!cf) {
      throw new ApiError(
        404,
        'cycle_not_found',
        `There is no cycle ${cycleId}. Check the cycle id or run the cycle first.`,
      );
    }
    const timeline = currentTimeline(await this.store.timeline(cycleId));
    return detailOf(cf, ledger.mandate, ctx, timeline);
  }

  async inbox(approverParty: string): Promise<ApprovalsInbox> {
    const { ledger, cycles } = await this.snapshot();
    return inboxOf(cycles, ledger.mandate, approverParty);
  }

  async decisionRecord(recordId: string): Promise<DecisionRecordView> {
    const records = await this.deps.ledger.reader.decisionRecords();
    const found = records.find((r) => r.payload.recordId === recordId);
    if (!found) {
      throw new ApiError(
        404,
        'record_not_found',
        `There is no decision record ${recordId}. Open it from a cycle's proposal.`,
      );
    }
    return decisionRecordView(found.payload);
  }

  async nextCycle(): Promise<NextCycle | null> {
    const mandate = await this.deps.ledger.reader.mandate();
    if (!mandate) return null;
    const { scheduleCron, scheduleTimezone } = mandate.payload.terms;
    let at: Date | null;
    try {
      at = nextRun(scheduleCron, scheduleTimezone, this.now());
    } catch {
      return null;
    }
    if (!at) return null;
    const cycleId = cycleIdForRun(at, scheduleTimezone);
    return { cycleId, label: labelOf(cycleId), at: at.toISOString() };
  }

  // ---------------------------------------------------------------------------------------
  // Running a cycle

  async run(input: RunInput): Promise<{ cycleId: string }> {
    const now = this.now();
    const cycleId = input.cycleId ?? defaultCycleId(now);
    if (!isCycleId(cycleId)) {
      throw new ApiError(
        400,
        'invalid_cycle',
        `"${cycleId}" is not a cycle id. Use the month being paid, like 2026-09.`,
      );
    }
    const mandate = await this.deps.ledger.reader.mandate();
    if (!mandate) {
      throw new ApiError(
        409,
        'no_mandate',
        'There is no sealed Mandate yet. Seal one in Settings before running a cycle.',
      );
    }
    const terms = mandate.payload.terms;
    const total = input.total ?? terms.fixedAmount;
    if (total === null || total === undefined) {
      throw new ApiError(
        422,
        'total_required',
        `Say how much to distribute, for example "Distribute 1,200 CC for ${monthName(cycleId)}."`,
      );
    }
    if (!toDecimal(total).gt(0)) {
      throw new ApiError(422, 'invalid_total', 'The total must be more than zero.');
    }
    const rule: RecordDateRule =
      terms.recordDateRule === 'day_before_payment'
        ? 'day_before_payment'
        : 'last_day_of_previous_month';
    const recordDate =
      input.recordDate ??
      recordDateFor(rule, cycleId, { cron: terms.scheduleCron, tz: terms.scheduleTimezone });
    if (recordDate > isoDateOf(now)) {
      throw new ApiError(
        422,
        'record_date_in_future',
        `The record date ${recordDate} has not happened yet, so units cannot be snapshotted. Pick a cycle that has ended or an earlier record date.`,
      );
    }
    // The ledger enforces the same rule in `Mandate_Propose`; saying so here gives a readable
    // refusal instead of a failed run.
    const dateProblem = recordDateProblem(rule, cycleId, recordDate);
    if (dateProblem !== null) {
      throw new ApiError(
        422,
        'invalid_record_date',
        `${dateProblem} The Mandate's rule is "${rule === 'day_before_payment' ? 'the day before payment' : 'last day of the previous month'}".`,
      );
    }

    const reserved = await this.store.reserve({
      cycleId,
      trigger: input.trigger,
      triggerDetail: input.triggerDetail,
      total,
      recordDate,
    });
    let row = reserved.row;
    if (!reserved.created) {
      const again: RunStatus[] = ['failed', 'rejected', 'cancelled'];
      if (!again.includes(row.status)) return { cycleId };
      // A new attempt: the cycle's run failed, or its proposal was rejected or cancelled.
      const claimed = await this.store.transition(row.id, again, {
        status: 'running',
        error: null,
        finishedAt: null,
        startedAt: now,
        trigger: input.trigger,
        triggerDetail: input.triggerDetail,
        total,
        recordDate,
        executesAt: null,
        held: false,
        fundsShortfall: null,
      });
      if (!claimed) return { cycleId };
      row = claimed;
    }
    await this.emitStatus(cycleId);
    void this.track(
      cycleId,
      this.pipeline(row, { ...input, cycleId, total, recordDate }).catch(() => undefined),
    );
    return { cycleId };
  }

  /** Cancels proposals a failed attempt left on the ledger, so a new attempt starts clean. */
  private async cancelStaleProposals(cycleId: string, actor: string): Promise<void> {
    const stale = (await this.deps.ledger.reader.proposals()).filter(
      (p) => p.payload.cycleId === cycleId,
    );
    for (const proposal of stale) {
      const cancelActor = actor === this.agent ? proposal.payload.treasurer : actor;
      await this.deps.ledger.client.submit({
        actAs: [cancelActor],
        readAs: this.readAs(),
        commands: [this.deps.ledger.commands.proposalCancel(proposal.contractId)],
        shape: 'LEDGER_EFFECTS',
      });
      await this.record(
        cancelActor,
        'cycle.cancelled',
        cycleId,
        `Cancelled the earlier proposal for ${labelOf(cycleId)} before a new attempt`,
        undefined,
        proposal.payload.seeded,
      );
    }
  }

  private async pipeline(
    row: CycleRunRow,
    input: RunInput & { cycleId: string; total: string; recordDate: string },
  ): Promise<void> {
    const { cycleId, total, recordDate } = input;
    const label = labelOf(cycleId);
    let current: StepId = 'woke';
    try {
      await this.step(cycleId, 'woke', 'done', input.triggerDetail);
      await this.cancelStaleProposals(cycleId, input.actorParty);

      const { reader } = this.deps.ledger;
      const [mandate, register, outcomes] = await Promise.all([
        reader.mandate(),
        reader.register(),
        reader.outcomes(),
      ]);
      if (!mandate || !register) {
        throw new StepError(
          'woke',
          'The Mandate or the unit register is not on the ledger yet. Finish the setup and run the cycle again.',
        );
      }
      const terms = mandate.payload.terms;
      const instrument = this.deps.assets.instrument();
      if (terms.asset.admin !== instrument.admin || terms.asset.id !== instrument.id) {
        throw new StepError(
          'woke',
          `The Mandate pays ${terms.asset.id} but the registry is configured for ${instrument.id}. Check ASSET_ADMIN_PARTY and ASSET_ID.`,
        );
      }

      // Snapshot (A2: units on the record date).
      current = 'snapshot';
      const holdings = unitsAt(recordDate, register.payload.changes);
      if (holdings.length === 0) {
        throw new StepError(
          'snapshot',
          `Nobody held fund units on ${recordDate}. Issue units first or pick a later record date.`,
        );
      }
      await this.step(
        cycleId,
        'snapshot',
        'done',
        `${plural(holdings.length, 'holder')} on ${shortDate(recordDate)}`,
      );

      // Amounts (A3: computed in code).
      current = 'amounts';
      let payouts: Payout[];
      try {
        payouts = computeProRata(total, holdings);
      } catch (error) {
        if (error instanceof ProRataError) throw new StepError('amounts', error.message);
        throw error;
      }
      await this.step(
        cycleId,
        'amounts',
        'done',
        `${formatAmount(total, this.symbol)} split by units`,
      );

      // Checks (A4).
      current = 'checks';
      // MainNet: the treasurer's balance lives in their Grofty wallet, which the server cannot
      // read. The balance check then says it is checked in the wallet before signing (P5).
      let balance: string | null = null;
      if (this.rail.kind === 'ledger') {
        try {
          balance = await this.deps.assets.balance(this.treasury);
        } catch (error) {
          throw new StepError(
            'checks',
            `Could not read the treasury balance: ${errorMessage(error)} Try again in a moment.`,
          );
        }
      }
      const executed = outcomes.filter((o) => HISTORY_KINDS.has(o.payload.kind));
      const executedHistory: HistoryEntry[] = executed.map((o) => ({
        cycleId: o.payload.cycleId,
        total: formatDecimal(
          o.payload.payments.reduce((sum, p) => sum.plus(toDecimal(p.amount)), new D(0)),
        ),
      }));
      const alreadyExecuted =
        mandate.payload.executedCycles.includes(cycleId) ||
        executed.some((o) => o.payload.cycleId === cycleId);
      const nameMap = new Map<string, string>();
      for (const party of new Set(register.payload.changes.map((c) => c.holder))) {
        nameMap.set(party, await this.nameOf(party));
      }
      const nameOf = (party: string): string => nameMap.get(party) ?? shortPartyId(party);
      const checks = runChecks({
        symbol: this.symbol,
        nameOf,
        cycleId,
        recordDate,
        trigger: input.trigger,
        total,
        payouts,
        holdingsOnRecordDate: holdings,
        changes: register.payload.changes,
        terms: {
          cap: terms.cap,
          feeBuffer: terms.feeBuffer,
          deviationPct: terms.deviationPct,
          trailingCycles: terms.trailingCycles,
          unitChangePct: terms.unitChangePct,
          unitChangeWindowDays: terms.unitChangeWindowDays,
          fixedAmount: terms.fixedAmount,
        },
        balance,
        alreadyExecuted,
        executedHistory,
      });
      const failed = checks.filter((c) => !c.passed);
      const duplicate = checks.find((c) => c.code === 'duplicate_cycle' && !c.passed);
      if (duplicate) {
        throw new StepError('checks', `A distribution for ${label} has already been executed`);
      }
      await this.step(
        cycleId,
        'checks',
        'done',
        `${checks.length - failed.length} passed, ${failed.length} flagged`,
      );

      // Review (A5: advisory only).
      current = 'review';
      await this.step(cycleId, 'review', 'running', 'Writing the memo');
      const history = selectHistory(executedHistory, cycleId, terms.trailingCycles);
      const overCap = toDecimal(total).gt(toDecimal(terms.cap));
      const blockingFailed = checks.filter((c) => c.blocking && !c.passed);
      const expectedVerdict =
        overCap || blockingFailed.length > 0 ? 'needs-approval' : 'within-mandate';
      const reasons = blockingFailed.map((c) =>
        c.code === 'cap'
          ? `Total is above the ${formatAmount(terms.cap, this.symbol)} cap`
          : c.actual,
      );
      if (overCap && !blockingFailed.some((c) => c.code === 'cap')) {
        reasons.push(`Total is above the ${formatAmount(terms.cap, this.symbol)} cap`);
      }
      const windowStart = addDays(recordDate, -terms.unitChangeWindowDays);
      const before = new Map(
        unitsAt(windowStart, register.payload.changes).map((h) => [h.holder, h.units]),
      );
      const holderChanges = holdings
        .filter((h) => (before.get(h.holder) ?? 0) !== h.units)
        .map((h) => ({
          holder: h.holder,
          displayName: nameOf(h.holder),
          unitsBefore: before.get(h.holder) ?? 0,
          unitsAfter: h.units,
        }));
      const totalUnits = holdings.reduce((sum, h) => sum + h.units, 0);
      const memoInput: MemoInput = {
        cycleId,
        cycleLabel: label,
        recordDate,
        total,
        assetSymbol: this.symbol,
        trigger: input.trigger,
        triggerDetail: input.triggerDetail,
        promptText: input.promptText ?? null,
        payouts: payouts.map((p) => ({
          holder: p.holder,
          displayName: nameOf(p.holder),
          units: p.units,
          sharePct: new D(p.units).times(100).div(totalUnits).toFixed(2),
          amount: p.amount,
        })),
        checks,
        history,
        holderChanges,
        verdict: expectedVerdict,
        verdictReasons: reasons,
        mandate: {
          version: mandate.payload.version,
          cap: terms.cap,
          approvalThreshold: terms.approvalThreshold,
          approverCount: terms.approvers.length,
        },
      };
      const memoResult = await this.writeMemo(memoInput);
      const advisory = sanitizeAdvisoryChecks(memoResult.advisoryChecks);
      await this.step(
        cycleId,
        'review',
        'done',
        memoResult.memoSource === 'ai'
          ? 'Memo written by the AI reviewer'
          : memoResult.memoSource === 'template'
            ? 'Memo written from the template'
            : 'AI reviewer unavailable, template memo used',
      );

      // Propose (L10: the decision record is created with the proposal).
      current = 'verdict';
      const fingerprints: Fingerprint[] = [
        { label: 'register', sha256: fingerprint({ recordDate, holdings }) },
        { label: 'mandate', sha256: fingerprint({ version: mandate.payload.version, terms }) },
        { label: 'history', sha256: fingerprint(history) },
        {
          label: 'balance',
          sha256: fingerprint({ asset: this.symbol, balance, total, feeBuffer: terms.feeBuffer }),
        },
        { label: 'payouts', sha256: fingerprint(payouts) },
      ];
      if (input.trigger === 'prompt' && input.promptText !== undefined) {
        fingerprints.push({ label: 'prompt', sha256: sha256Hex(input.promptText) });
      }
      const proposalInput: Omit<ProposalInput, 'attempt'> = {
        cycleId,
        cycleLabel: label,
        total,
        recordDate,
        trigger: TRIGGER_ENUM[input.trigger],
        triggerDetail: input.triggerDetail,
        payouts,
        registerCid: register.contractId,
        inputFingerprints: fingerprints,
        checks: [...checks, ...advisory],
        memo: memoResult.memo,
        memoSource: memoResult.memoSource,
        modelFingerprints: [...(input.modelFingerprints ?? []), ...memoResult.modelFingerprints],
        seeded: input.seeded ?? false,
      };
      const { proposal, updateId, decisionRecordCid } = await this.propose(proposalInput);

      const balanceCheck = checks.find((c) => c.code === 'balance');
      const required = formatDecimal(toDecimal(total).plus(toDecimal(terms.feeBuffer)));
      const shortfall: Shortfall | null =
        balance !== null && balanceCheck && !balanceCheck.passed
          ? { balance: formatDecimal(toDecimal(balance)), required }
          : null;
      const auto = proposal.payload.verdict === 'AutoExecute';
      const agentExecutes = mandate.payload.agentExecutes;
      const executesAt =
        auto && agentExecutes
          ? new Date(new Date(proposal.payload.createdAt).getTime() + this.countdownMs)
          : null;
      await this.store.transition(row.id, ['running'], {
        status: 'proposed',
        total,
        recordDate,
        executesAt,
        held: false,
        fundsShortfall: shortfall,
      });
      await this.store.setTxRef(decisionRecordCid, updateId, 'decision');
      await this.store.setTxRef(proposal.contractId, updateId, 'proposal');
      const verdictText = auto
        ? 'Within mandate'
        : `Needs ${terms.approvalThreshold} of ${plural(terms.approvers.length, 'approval')}`;
      await this.step(cycleId, 'verdict', 'done', verdictText);
      await this.record(
        input.actorParty,
        'cycle.proposed',
        cycleId,
        `Prepared ${label}: ${formatAmount(total, this.symbol)} to ${plural(payouts.length, 'holder')}, ${auto ? 'within the mandate' : verdictText.toLowerCase()}`,
        { proposalId: proposal.payload.proposalId, verdict: proposal.payload.verdict },
        input.seeded ?? false,
      );
      if (shortfall) {
        await this.recordNeedsFunds(
          cycleId,
          shortfall.balance,
          shortfall.required,
          input.seeded ?? false,
        );
      }
      if (executesAt) this.schedule(cycleId, executesAt);
      await this.emitStatus(cycleId);
    } catch (error) {
      await this.failRun(row, current, error, input.actorParty, input.seeded ?? false);
    }
  }

  private async writeMemo(input: MemoInput): Promise<MemoResult> {
    try {
      const result = await this.memoWriter.write(input);
      if (result.memo.trim() === '') throw new Error('The memo writer returned an empty memo');
      return result;
    } catch {
      // A writer that fails is treated as unavailable (A11): the proposal still goes out with a
      // deterministic memo, and the record says so.
      const fallback = await new TemplateMemoWriter().write(input);
      return { ...fallback, memoSource: 'ai-unavailable' };
    }
  }

  /**
   * `Mandate_Propose` as the agent, retried when the Mandate contract changed under us. The
   * Mandate keeps the newest attempt number per cycle and the ledger accepts only the next one,
   * so the attempt is read from the Mandate being proposed against (`Mandate_Propose` consumes
   * it, which is also why each try reads the Mandate again).
   */
  private async propose(
    input: Omit<ProposalInput, 'attempt'>,
  ): Promise<{ proposal: Contract<Proposal>; updateId: string; decisionRecordCid: string }> {
    const { reader, client, commands } = this.deps.ledger;
    return this.mandateLock.run(async () => {
      for (let attemptNo = 1; ; attemptNo += 1) {
        const mandate = await reader.mandate();
        if (!mandate) throw new Error('The Mandate is no longer on the ledger');
        try {
          const tx = await client.submit({
            actAs: [this.agent],
            readAs: this.readAs(),
            commands: [
              commands.mandatePropose(mandate.contractId, {
                ...input,
                attempt: nextAttempt(mandate.payload, input.cycleId),
              }),
            ],
            shape: 'LEDGER_EFFECTS',
          });
          const ids = choiceResults.mandatePropose(tx);
          const created = createdIn(tx, 'Mithra.Proposal:Proposal').find(
            (e) => e.contractId === ids.proposalCid,
          );
          if (!created) throw new Error('The ledger did not return the new proposal');
          return {
            proposal: {
              contractId: created.contractId,
              payload: ProposalSchema.parse(created.createArgument),
              createdAt: created.createdAt,
            },
            updateId: tx.updateId,
            decisionRecordCid: ids.decisionRecordCid,
          };
        } catch (error) {
          if (attemptNo < 3 && isStaleContract(error)) continue;
          throw error;
        }
      }
    });
  }

  private async failRun(
    row: CycleRunRow,
    step: StepId,
    error: unknown,
    actor: string,
    seeded: boolean,
  ): Promise<void> {
    const stepFailure = error instanceof StepError ? error : null;
    const failedStep = stepFailure?.step ?? step;
    const message =
      stepFailure || error instanceof LedgerError || error instanceof ApiError
        ? errorMessage(error)
        : `Something went wrong while preparing ${labelOf(row.cycleId)}: ${errorMessage(error)} Run the cycle again.`;
    await this.store.transition(row.id, ['running'], {
      status: 'failed',
      error: message,
      finishedAt: this.now(),
    });
    await this.step(row.cycleId, failedStep, 'failed', message).catch(() => undefined);
    await this.record(
      actor,
      'cycle.failed',
      row.cycleId,
      `${labelOf(row.cycleId)} could not be prepared: ${message}`,
      undefined,
      seeded,
    );
    await this.emitStatus(row.cycleId);
  }

  // ---------------------------------------------------------------------------------------
  // Hold countdown

  private schedule(cycleId: string, executesAt: Date): void {
    if (!this.timersOn) return;
    this.unschedule(cycleId);
    const delay = Math.max(executesAt.getTime() - this.now().getTime(), 0) + 50;
    const timer = setTimeout(() => {
      this.timers.delete(cycleId);
      void this.advance(cycleId).catch(() => undefined);
    }, delay);
    timer.unref();
    this.timers.set(cycleId, timer);
  }

  private unschedule(cycleId: string): void {
    const timer = this.timers.get(cycleId);
    if (timer) clearTimeout(timer);
    this.timers.delete(cycleId);
  }

  private async rowOrThrow(cycleId: string): Promise<CycleRunRow> {
    const row = await this.store.get(cycleId);
    if (!row) {
      throw new ApiError(
        404,
        'cycle_not_found',
        `There is no cycle ${cycleId}. Check the cycle id or run the cycle first.`,
      );
    }
    return row;
  }

  private async activeProposal(cycleId: string): Promise<Contract<Proposal> | null> {
    const proposals = (await this.deps.ledger.reader.proposals()).filter(
      (p) => p.payload.cycleId === cycleId,
    );
    return (
      proposals.sort((a, b) =>
        a.payload.proposalId < b.payload.proposalId
          ? 1
          : a.payload.proposalId > b.payload.proposalId
            ? -1
            : 0,
      )[0] ?? null
    );
  }

  async hold(cycleId: string, actorParty: string): Promise<CycleDetail> {
    const row = await this.rowOrThrow(cycleId);
    const proposal = await this.activeProposal(cycleId);
    if (!proposal || proposal.payload.verdict !== 'AutoExecute') {
      throw new ApiError(
        409,
        'not_holdable',
        'Only a proposal that is paying automatically after a countdown can be held. This one is not.',
      );
    }
    if (row.held && row.status === 'proposed') return this.getCycle(cycleId);
    const held = await this.store.transition(row.id, ['proposed'], { held: true });
    if (!held) {
      throw new ApiError(
        409,
        'too_late',
        `The payments for ${labelOf(cycleId)} are already on their way and can no longer be held.`,
      );
    }
    this.unschedule(cycleId);
    await this.record(
      actorParty,
      'cycle.held',
      cycleId,
      `${await this.nameOf(actorParty)} held ${labelOf(cycleId)}`,
    );
    await this.emitStatus(cycleId);
    return this.getCycle(cycleId);
  }

  async release(cycleId: string, actorParty: string): Promise<CycleDetail> {
    const row = await this.rowOrThrow(cycleId);
    if (!row.held) return this.getCycle(cycleId);
    const released = await this.store.transition(row.id, ['proposed'], { held: false });
    if (!released) {
      throw new ApiError(409, 'not_held', `${labelOf(cycleId)} is not waiting on a hold any more.`);
    }
    await this.record(
      actorParty,
      'cycle.released',
      cycleId,
      `${await this.nameOf(actorParty)} released ${labelOf(cycleId)}`,
    );
    const due =
      released.executesAt === null || released.executesAt.getTime() <= this.now().getTime();
    if (due) {
      void this.track(
        cycleId,
        this.executeNow(cycleId).catch(() => undefined),
      );
    } else if (released.executesAt) {
      this.schedule(cycleId, released.executesAt);
    }
    await this.emitStatus(cycleId);
    return this.getCycle(cycleId);
  }

  /** L11: the treasurer cancels a proposal that has not been paid. */
  async cancel(cycleId: string, actorParty: string): Promise<CycleDetail> {
    const row = await this.rowOrThrow(cycleId);
    const proposal = await this.activeProposal(cycleId);
    if (!proposal) {
      throw new ApiError(
        409,
        'nothing_to_cancel',
        `${labelOf(cycleId)} has no open proposal to cancel. It may already be paid, rejected or cancelled.`,
      );
    }
    // Take the row first so the countdown timer or an approval cannot start the payout meanwhile.
    const locked = await this.store.transition(row.id, ['proposed', 'failed'], {
      status: 'cancelled',
    });
    if (!locked) {
      throw new ApiError(
        409,
        'too_late',
        `The payments for ${labelOf(cycleId)} are already on their way and can no longer be cancelled.`,
      );
    }
    this.unschedule(cycleId);
    try {
      await this.deps.ledger.client.submit({
        actAs: [actorParty],
        readAs: this.readAs(),
        commands: [this.deps.ledger.commands.proposalCancel(proposal.contractId)],
        shape: 'LEDGER_EFFECTS',
      });
    } catch (error) {
      await this.store.patch(row.id, { status: row.status });
      throw error;
    }
    await this.store.patch(row.id, { finishedAt: this.now(), fundsShortfall: null });
    await this.record(
      actorParty,
      'cycle.cancelled',
      cycleId,
      `${await this.nameOf(actorParty)} cancelled ${labelOf(cycleId)}`,
    );
    await this.emitStatus(cycleId);
    return this.getCycle(cycleId);
  }

  // ---------------------------------------------------------------------------------------
  // Approvals

  private async proposalById(proposalId: string): Promise<Contract<Proposal>> {
    const proposals = await this.deps.ledger.reader.proposals();
    const found = proposals.find((p) => p.payload.proposalId === proposalId);
    if (!found) {
      throw new ApiError(
        404,
        'proposal_not_found',
        'That proposal is no longer open. It may have been paid, rejected or cancelled; check the cycle.',
      );
    }
    return found;
  }

  /** The run row of a cycle, created for a proposal that was made outside this app (seeded or restored). */
  private async ensureRow(proposal: Contract<Proposal>): Promise<CycleRunRow> {
    const cycleId = proposal.payload.cycleId;
    const existing = await this.store.get(cycleId);
    if (existing) return existing;
    const reserved = await this.store.reserve({
      cycleId,
      trigger: 'manual',
      triggerDetail: 'Proposal found on the ledger',
      total: proposal.payload.total,
      recordDate: proposal.payload.recordDate,
    });
    return (
      (await this.store.transition(reserved.row.id, ['running'], { status: 'proposed' })) ??
      reserved.row
    );
  }

  async approve(proposalId: string, approverParty: string, note: string): Promise<CycleDetail> {
    const proposal = await this.proposalById(proposalId);
    const cycleId = proposal.payload.cycleId;
    await this.ensureRow(proposal);
    await this.deps.ledger.client.submit({
      actAs: [approverParty],
      commands: [
        this.deps.ledger.commands.proposalApprove(proposal.contractId, {
          approver: approverParty,
          note,
        }),
      ],
      shape: 'LEDGER_EFFECTS',
    });
    // The true count, from the ledger (U3).
    const [after, mandate] = await Promise.all([
      this.proposalById(proposalId),
      this.deps.ledger.reader.mandate(),
    ]);
    const approvers = mandate?.payload.terms.approvers ?? after.payload.approvers;
    const need = mandate?.payload.terms.approvalThreshold ?? after.payload.approvalThreshold;
    const have = validApprovalCount(after.payload.approvals, approvers);
    await this.record(
      approverParty,
      'proposal.approved',
      cycleId,
      `${await this.nameOf(approverParty)} approved ${labelOf(cycleId)} (${have} of ${need})`,
      { have, need },
    );
    if (have >= need) {
      void this.track(
        cycleId,
        this.executeNow(cycleId).catch(() => undefined),
      );
    }
    await this.emitStatus(cycleId);
    return this.getCycle(cycleId);
  }

  async reject(proposalId: string, approverParty: string, reason: string): Promise<CycleDetail> {
    const proposal = await this.proposalById(proposalId);
    const cycleId = proposal.payload.cycleId;
    const row = await this.ensureRow(proposal);
    const locked = await this.store.transition(row.id, ['proposed', 'failed'], {
      status: 'rejected',
    });
    if (!locked) {
      throw new ApiError(
        409,
        'too_late',
        `The payments for ${labelOf(cycleId)} are already on their way and can no longer be rejected.`,
      );
    }
    this.unschedule(cycleId);
    try {
      await this.deps.ledger.client.submit({
        actAs: [approverParty],
        commands: [
          this.deps.ledger.commands.proposalReject(proposal.contractId, {
            approver: approverParty,
            reason,
          }),
        ],
        shape: 'LEDGER_EFFECTS',
      });
    } catch (error) {
      await this.store.patch(row.id, { status: row.status });
      throw error;
    }
    await this.store.patch(row.id, { finishedAt: this.now(), fundsShortfall: null });
    await this.record(
      approverParty,
      'proposal.rejected',
      cycleId,
      `${await this.nameOf(approverParty)} rejected ${labelOf(cycleId)}: ${reason}`,
    );
    await this.emitStatus(cycleId);
    return this.getCycle(cycleId);
  }

  // ---------------------------------------------------------------------------------------
  // Executing

  /**
   * Whether the proposal may be paid now, and if not, why. The ledger enforces the same rules
   * (L1, L4); this keeps a refusal from becoming a failed attempt.
   */
  private readiness(
    row: CycleRunRow,
    proposal: Contract<Proposal>,
    mandate: Contract<Mandate>,
  ): { ready: true } | { ready: false; code: string; message: string } {
    const label = labelOf(row.cycleId);
    if (proposal.payload.verdict === 'AutoExecute') {
      if (row.held) {
        return {
          ready: false,
          code: 'held',
          message: `${label} is on hold. Release it to pay.`,
        };
      }
      if (row.executesAt && row.executesAt.getTime() > this.now().getTime()) {
        return {
          ready: false,
          code: 'countdown',
          message: `The countdown for ${label} has not finished yet.`,
        };
      }
      return { ready: true };
    }
    const have = validApprovalCount(proposal.payload.approvals, mandate.payload.terms.approvers);
    const need = mandate.payload.terms.approvalThreshold;
    if (have < need) {
      return {
        ready: false,
        code: 'approvals_missing',
        message: `${label} needs ${need} approval${need === 1 ? '' : 's'} from the Mandate's approvers and has ${have}. It is paid once the threshold is met.`,
      };
    }
    return { ready: true };
  }

  async execute(cycleId: string): Promise<CycleDetail> {
    const row = await this.rowOrThrow(cycleId);
    if (row.status === 'executed') {
      throw new ApiError(
        409,
        'already_executed',
        `A distribution for ${labelOf(cycleId)} has already been executed. Nothing is paid twice.`,
      );
    }
    if (row.status !== 'proposed' && row.status !== 'failed') {
      throw new ApiError(
        409,
        'not_executable',
        `${labelOf(cycleId)} is ${row.status} and cannot be paid right now.`,
      );
    }
    const [proposal, mandate] = await Promise.all([
      this.activeProposal(cycleId),
      this.deps.ledger.reader.mandate(),
    ]);
    if (!proposal || !mandate) {
      throw new ApiError(
        409,
        'no_open_proposal',
        `${labelOf(cycleId)} has no open proposal. Run the cycle to prepare one.`,
      );
    }
    const gate = this.readiness(row, proposal, mandate);
    if (!gate.ready) throw new ApiError(409, gate.code, gate.message);
    if (row.status === 'failed') {
      await this.store.transition(row.id, ['failed'], {
        status: 'proposed',
        error: null,
        finishedAt: null,
      });
    }
    await this.track(cycleId, this.executeNow(cycleId));
    return this.getCycle(cycleId);
  }

  async waitingCycleIds(): Promise<string[]> {
    return (await this.store.withStatus(['proposed'])).map((r) => r.cycleId);
  }

  async advance(cycleId: string): Promise<AdvanceResult> {
    if (this.inflight.has(cycleId)) return 'busy';
    const row = await this.store.get(cycleId);
    if (!row || row.status !== 'proposed') return 'idle';
    const [proposal, mandate] = await Promise.all([
      this.activeProposal(cycleId),
      this.deps.ledger.reader.mandate(),
    ]);
    if (!proposal || !mandate) {
      await this.syncFromLedger(row);
      return 'idle';
    }
    const gate = this.readiness(row, proposal, mandate);
    if (!gate.ready) {
      if (row.fundsShortfall !== null) await this.recheckFunds(row, proposal, mandate);
      return 'waiting';
    }
    try {
      return await this.track(cycleId, this.executeNow(cycleId));
    } catch {
      // The failure is recorded on the cycle; the reconciler goes on with the other cycles.
      return 'failed';
    }
  }

  /** Clears a stored shortfall once the balance covers the payout again, before the payout is due. */
  private async recheckFunds(
    row: CycleRunRow,
    proposal: Contract<Proposal>,
    mandate: Contract<Mandate>,
  ): Promise<void> {
    try {
      const balance = await this.deps.assets.balance(this.treasury);
      const required = toDecimal(proposal.payload.total).plus(
        toDecimal(mandate.payload.terms.feeBuffer),
      );
      if (toDecimal(balance).gte(required)) {
        await this.store.patch(row.id, { fundsShortfall: null });
        await this.emitStatus(row.cycleId);
      }
    } catch {
      // Keep the shortfall; the next pass checks again.
    }
  }

  /** The ledger shows how a cycle ended even when this app did not see it (another instance, a crash). */
  private async syncFromLedger(row: CycleRunRow): Promise<void> {
    const outcomes = (await this.deps.ledger.reader.outcomes())
      .filter((o) => o.payload.cycleId === row.cycleId)
      .sort((a, b) => (a.payload.at < b.payload.at ? 1 : a.payload.at > b.payload.at ? -1 : 0));
    const latest = outcomes[0];
    if (!latest) return;
    const status =
      latest.payload.kind === 'Executed'
        ? 'executed'
        : latest.payload.kind === 'Rejected'
          ? 'rejected'
          : 'cancelled';
    await this.store.transition(row.id, ['proposed', 'executing', 'running'], {
      status,
      finishedAt: this.now(),
      fundsShortfall: null,
      error: null,
    });
    await this.emitStatus(row.cycleId);
  }

  private async recordNeedsFunds(
    cycleId: string,
    balance: string,
    required: string,
    seeded: boolean,
  ): Promise<void> {
    await this.record(
      this.agent,
      'cycle.needs-funds',
      cycleId,
      `${labelOf(cycleId)} is waiting for funds: the treasury holds ${formatAmount(balance, this.symbol)} and needs ${formatAmount(required, this.symbol)}. Add funds.`,
      undefined,
      seeded,
    );
  }

  /**
   * Pays a ready proposal: claims the row (one executor at a time), re-reads the proposal and the
   * Mandate, and hands it to the payout rail. On LocalNet the rail checks the live balance (P5),
   * selects inputs, builds one transfer per payout with the asset adapter and submits
   * `Mandate_AgentExecute` with a command id that makes a retry safe. On MainNet it authorizes the
   * payout on the ledger (`Mandate_AuthorizeExternalPayout`) and the treasurer signs the transfers
   * in Grofty. The transaction, the activity and the status are recorded only after the ledger
   * confirms (P4).
   */
  private async executeNow(cycleId: string): Promise<AdvanceResult> {
    const row = await this.store.get(cycleId);
    if (!row) return 'idle';
    const claimed = await this.store.transition(row.id, ['proposed'], { status: 'executing' });
    if (!claimed) return 'busy';
    this.unschedule(cycleId);
    const label = labelOf(cycleId);
    const revert = async (patch: {
      error?: string | null;
      fundsShortfall?: Shortfall | null;
    }): Promise<void> => {
      await this.store.transition(row.id, ['executing'], { status: 'proposed', ...patch });
    };
    try {
      const [proposal, mandate] = await Promise.all([
        this.activeProposal(cycleId),
        this.deps.ledger.reader.mandate(),
      ]);
      if (!proposal || !mandate) {
        await revert({});
        await this.syncFromLedger(row);
        return 'idle';
      }
      const gate = this.readiness({ ...row, status: 'proposed' }, proposal, mandate);
      if (!gate.ready) {
        await revert({});
        return 'waiting';
      }

      const result = await this.rail.run(
        { cycleId, label, proposal, mandate },
        {
          announce: async () => {
            await this.step(
              cycleId,
              'execute',
              'running',
              this.rail.kind === 'grofty-mainnet'
                ? 'Checking the Mandate rules on the ledger'
                : 'Sent to the ledger, waiting for it to confirm',
            );
            await this.emitStatus(cycleId);
          },
        },
      );
      return await this.afterRail(row, proposal, result, label, revert);
    } catch (error) {
      if (isTransient(error)) {
        const text = `The ledger has not confirmed the payments for ${label} yet (${errorMessage(error)}). Mithra checks again shortly; nothing is paid twice.`;
        await revert({ error: text });
        await this.emitStatus(cycleId);
        return 'retry';
      }
      const message = errorMessage(error);
      await this.store.transition(row.id, ['executing'], {
        status: 'failed',
        error: message,
        finishedAt: this.now(),
      });
      await this.step(cycleId, 'execute', 'failed', message).catch(() => undefined);
      await this.record(
        this.agent,
        'cycle.failed',
        cycleId,
        `The payments for ${label} did not go through: ${message}`,
      );
      await this.emitStatus(cycleId);
      throw error;
    }
  }

  /** What to do with the rail's answer. */
  private async afterRail(
    row: CycleRunRow,
    proposal: Contract<Proposal>,
    result: RailResult,
    label: string,
    revert: (patch: { error?: string | null; fundsShortfall?: Shortfall | null }) => Promise<void>,
  ): Promise<AdvanceResult> {
    const cycleId = row.cycleId;
    switch (result.kind) {
      case 'needs-funds': {
        const shortfall: Shortfall = { balance: result.balance, required: result.required };
        const changed = JSON.stringify(row.fundsShortfall) !== JSON.stringify(shortfall);
        await revert({ fundsShortfall: shortfall });
        if (changed) {
          await this.recordNeedsFunds(
            cycleId,
            result.balance,
            result.required,
            proposal.payload.seeded,
          );
          await this.emitStatus(cycleId);
        }
        return 'needs-funds';
      }
      case 'needs-wallets': {
        await revert({});
        const names = await Promise.all(result.holders.map((h) => this.nameOf(h)));
        const text = `Waiting for ${names.join(', ')} to connect Grofty Wallet`;
        await this.step(cycleId, 'execute', 'pending', text);
        if (this.walletsNoted.get(cycleId) !== text) {
          this.walletsNoted.set(cycleId, text);
          await this.record(
            this.agent,
            'cycle.needs-wallets',
            cycleId,
            `${label} is ready to pay but ${names.join(', ')} ${names.length === 1 ? 'has' : 'have'} not connected Grofty Wallet yet`,
            { holders: result.holders },
            proposal.payload.seeded,
          );
        }
        await this.emitStatus(cycleId);
        return 'needs-wallets';
      }
      case 'authorized':
        await this.afterAuthorization(row, proposal, result.tx, label);
        return 'awaiting-signature';
      case 'paid':
        await this.afterExecution(row, proposal, result.tx, label);
        return 'executed';
    }
  }

  /**
   * MainNet: the ledger authorized the payout and created one `PendingExternal` Payment per payee.
   * Nothing is paid yet (P4): the cycle waits for the treasurer's signatures in Grofty, and the
   * payments are recorded one by one (`mainnet/payouts.ts`).
   */
  private async afterAuthorization(
    row: CycleRunRow,
    proposal: Contract<Proposal>,
    tx: Transaction,
    label: string,
  ): Promise<void> {
    const cycleId = row.cycleId;
    const created = createdIn(tx, 'Mithra.Decision:DistributionOutcome')[0];
    if (created) await this.store.setTxRef(created.contractId, tx.updateId, 'outcome');
    await this.store.transition(row.id, ['executing'], {
      status: 'executed',
      finishedAt: this.now(),
      error: null,
      fundsShortfall: null,
    });
    this.walletsNoted.delete(cycleId);
    const count = proposal.payload.payouts.length;
    await this.step(
      cycleId,
      'execute',
      'running',
      `Authorized on the ledger. Sign ${count === 1 ? 'the payout' : `${count} payouts`} of ${formatAmount(proposal.payload.total, this.symbol)} in Grofty`,
    );
    await this.record(
      this.agent,
      'payout.authorized',
      cycleId,
      `${label} is ready to pay: ${formatAmount(proposal.payload.total, this.symbol)} to ${plural(count, 'holder')}, waiting for the treasurer to sign in Grofty`,
      { updateId: tx.updateId },
      proposal.payload.seeded,
    );
    await this.emitStatus(cycleId);
  }

  private async afterExecution(
    row: CycleRunRow,
    proposal: Contract<Proposal>,
    tx: Transaction,
    label: string,
  ): Promise<void> {
    const cycleId = row.cycleId;
    const created = createdIn(tx, 'Mithra.Decision:DistributionOutcome')[0];
    const outcome = created ? DistributionOutcomeSchema.parse(created.createArgument) : null;
    if (created) await this.store.setTxRef(created.contractId, tx.updateId, 'outcome');
    for (const payment of createdIn(tx, 'Mithra.Payment:Payment')) {
      await this.store.setTxRef(payment.contractId, tx.updateId, 'payment');
    }
    await this.store.transition(row.id, ['executing'], {
      status: 'executed',
      finishedAt: this.now(),
      error: null,
      fundsShortfall: null,
    });
    const refs = outcome?.payments ?? [];
    const awaiting = refs.filter((r) => r.status === 'AwaitingAcceptance');
    await this.step(
      cycleId,
      'execute',
      'done',
      awaiting.length === 0
        ? `Paid ${formatAmount(proposal.payload.total, this.symbol)} to ${plural(proposal.payload.payouts.length, 'holder')}`
        : `Sent ${formatAmount(proposal.payload.total, this.symbol)} to ${plural(proposal.payload.payouts.length, 'holder')}; ${awaiting.length} awaiting acceptance`,
    );
    await this.record(
      this.agent,
      'payment.paid',
      cycleId,
      `Paid ${formatAmount(proposal.payload.total, this.symbol)} to ${plural(proposal.payload.payouts.length, 'holder')} for ${label}`,
      { updateId: tx.updateId },
      proposal.payload.seeded,
    );
    for (const ref of awaiting) {
      await this.record(
        this.agent,
        'payment.awaiting',
        cycleId,
        `${await this.nameOf(ref.holder)} has a payment awaiting acceptance`,
        { holder: ref.holder },
        proposal.payload.seeded,
      );
    }
    for (const payout of proposal.payload.payouts) {
      this.deps.bus.publish({ type: 'holder', change: 'payments' }, { parties: [payout.holder] });
    }
    await this.emitStatus(cycleId);
  }

  // ---------------------------------------------------------------------------------------
  // Recovery

  async recoverStale(): Promise<void> {
    const now = this.now().getTime();
    for (const row of await this.store.withStatus(['running'])) {
      if (this.inflight.has(row.cycleId)) continue;
      if (now - row.updatedAt.getTime() < STALE_RUN_MS) continue;
      await this.store.transition(row.id, ['running'], {
        status: 'failed',
        error:
          'The run was interrupted before it finished (the server restarted). Run the cycle again.',
        finishedAt: this.now(),
      });
      await this.emitStatus(row.cycleId);
    }
    for (const row of await this.store.withStatus(['executing'])) {
      if (this.inflight.has(row.cycleId)) continue;
      if (now - row.updatedAt.getTime() < STALE_EXECUTION_MS) continue;
      // The payout may or may not have reached the ledger; the command id makes a retry safe, and
      // `advance` reads the outcome first.
      await this.store.transition(row.id, ['executing'], { status: 'proposed' });
    }
  }
}
