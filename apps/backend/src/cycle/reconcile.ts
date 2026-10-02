import type { Config } from '../config/env';
import type { Database } from '../db';
import { TREASURY_TEAM, type EventBus } from '../events/bus';
import type { ActivityLog } from '../activity/log';
import type { MandateSealer } from '../governance/sealer';
import { choiceResults, LedgerError, type Ledger, type Transaction } from '../ledger';
import type { PartyNames } from '../parties/names';
import type { CycleService } from './engine';
import { formatAmount, cycleLabel as labelOf } from './format';
import { CycleStore } from './store';

/**
 * How a pending transfer ended, from the transaction that archived its instruction.
 *
 * Detecting accept versus reject (documented choice): the `Payment` keeps the id of the transfer
 * instruction. When that contract is no longer active, the app asks the ledger when it was
 * archived (`/v2/events/events-by-contract-id`, the archive offset), reads the transaction at that
 * offset with LEDGER_EFFECTS (`/v2/updates/update-by-offset`, which also gives the update id for
 * the payment link) and looks at which choice consumed the instruction: `TransferInstruction_Accept`
 * means the holder took the payment. This is exact. Looking for the receiver's new holding instead
 * cannot tell a rejection (funds back to the treasury) from a transfer to another holder.
 */
export type ArchiveReason = 'accepted' | 'rejected' | 'withdrawn' | 'updated' | 'unknown';

export function classifyArchive(
  tx: Transaction,
  instructionCid: string,
): { reason: ArchiveReason; updateId: string } {
  for (const event of tx.events) {
    if (event.kind !== 'exercised' || event.contractId !== instructionCid || !event.consuming) {
      continue;
    }
    switch (event.choice) {
      case 'TransferInstruction_Accept':
        return { reason: 'accepted', updateId: tx.updateId };
      case 'TransferInstruction_Reject':
        return { reason: 'rejected', updateId: tx.updateId };
      case 'TransferInstruction_Withdraw':
        return { reason: 'withdrawn', updateId: tx.updateId };
      case 'TransferInstruction_Update':
        return { reason: 'updated', updateId: tx.updateId };
      default:
        return { reason: 'unknown', updateId: tx.updateId };
    }
  }
  return { reason: 'unknown', updateId: tx.updateId };
}

export interface ReconcileReport {
  /** Cycles a pass paid. */
  executed: string[];
  /** Payments marked Paid after the holder accepted. */
  accepted: string[];
  /** Payments whose transfer was rejected or withdrawn. */
  declined: string[];
  /** Seal requests advanced. */
  sealsAdvanced: string[];
}

export interface ReconcilerDeps {
  config: Config;
  db: Database;
  ledger: Pick<Ledger, 'client' | 'reader' | 'commands'>;
  cycles: CycleService;
  names: PartyNames;
  activity: ActivityLog;
  bus: EventBus;
  /** Advanced on every pass when present. */
  sealer?: MandateSealer;
  /** Where bookkeeping failures are logged. */
  log?: { warn(object: unknown, message?: string): void };
  /** Replaces the cycle store (tests); default: PostgreSQL through `db`. */
  store?: CycleStore;
}

export interface Reconciler {
  /** One full pass: stale runs, due countdowns, approved proposals, pending acceptances, seals. */
  reconcileOnce(): Promise<ReconcileReport>;
  /** Only the pending-acceptance pass; the holder's accept route can call it right away. */
  reconcilePayments(): Promise<ReconcileReport>;
  start(): void;
  stop(): void;
}

const EMPTY = (): ReconcileReport => ({
  executed: [],
  accepted: [],
  declined: [],
  sealsAdvanced: [],
});

/**
 * The background pass that keeps the ledger and the app in step, so nothing depends on a timer
 * surviving a restart:
 * - executes countdowns that are due (also after a restart, from `cycle_runs`),
 * - executes proposals whose approvals reached the threshold, and retries ones waiting for funds,
 * - marks `AwaitingAcceptance` payments `Paid` once the holder accepted the transfer,
 * - advances Mandate seal requests waiting for node confirmations.
 */
export function createReconciler(deps: ReconcilerDeps, intervalMs = 10_000): Reconciler {
  const store = deps.store ?? new CycleStore(deps.db, deps.config.parties.treasury);
  const treasury = deps.config.parties.treasury;
  const agent = deps.config.parties.agent;
  const viewers = deps.config.ledger.readAsTreasury ? [treasury] : [agent];
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<ReconcileReport> | undefined;
  let stopped = true;

  async function publishCycle(cycleId: string): Promise<void> {
    try {
      const detail = await deps.cycles.getCycle(cycleId);
      deps.bus.publish({ type: 'cycle', cycleId, status: detail.summary.status }, TREASURY_TEAM);
    } catch {
      // A missed live update is harmless.
    }
  }

  async function reconcilePayments(): Promise<ReconcileReport> {
    const report = EMPTY();
    const payments = (await deps.ledger.reader.payments()).filter(
      (p) => p.payload.status === 'AwaitingAcceptance' && p.payload.transferInstructionCid,
    );
    for (const payment of payments) {
      const instructionCid = payment.payload.transferInstructionCid;
      if (!instructionCid) continue;
      try {
        const events = await deps.ledger.client.eventsByContractId(instructionCid, viewers);
        if (events.archivedAtOffset === null) continue; // still waiting for the holder
        const tx = await deps.ledger.client.updateByOffset(events.archivedAtOffset, viewers);
        const { reason, updateId } = classifyArchive(tx, instructionCid);
        const label = labelOf(payment.payload.cycleId);
        const holderName = await deps.names.name(payment.payload.holder);
        const amount = formatAmount(payment.payload.amount, deps.config.asset.symbol);
        if (reason === 'accepted') {
          const marked = await deps.ledger.client.submit({
            actAs: [agent],
            readAs: deps.config.ledger.readAsTreasury ? [treasury] : [],
            commands: [deps.ledger.commands.paymentMarkAccepted(payment.contractId)],
            shape: 'LEDGER_EFFECTS',
          });
          // The ledger has the payment marked now. A failure in the bookkeeping below is logged
          // and must neither fail the pass nor skip the payments after this one.
          try {
            const { paymentCid } = choiceResults.paymentMarkAccepted(marked);
            await store.setTxRef(paymentCid, updateId, 'payment');
          } catch (error) {
            deps.log?.warn(
              { err: error, cycleId: payment.payload.cycleId },
              'could not save the link of an accepted payment',
            );
          }
          try {
            await deps.activity.record({
              actorParty: agent,
              kind: 'payment.accepted',
              subject: payment.payload.cycleId,
              text: `${holderName} accepted the payment of ${amount} for ${label}`,
              link: `/app/cycles/${payment.payload.cycleId}`,
            });
          } catch (error) {
            deps.log?.warn(
              { err: error, cycleId: payment.payload.cycleId },
              'could not record an accepted payment in the activity log',
            );
          }
          deps.bus.publish(
            { type: 'holder', change: 'payments' },
            { parties: [payment.payload.holder] },
          );
          await publishCycle(payment.payload.cycleId);
          report.accepted.push(payment.payload.cycleId);
        } else if (reason === 'rejected' || reason === 'withdrawn') {
          if (await store.hasTxRef(payment.contractId, 'payment-declined')) continue;
          await store.setTxRef(payment.contractId, updateId, 'payment-declined');
          await deps.activity.record({
            actorParty: agent,
            kind: 'payment.declined',
            subject: payment.payload.cycleId,
            text: `${holderName} did not accept the payment of ${amount} for ${label}; the funds are back in the treasury`,
            link: `/app/cycles/${payment.payload.cycleId}`,
          });
          report.declined.push(payment.payload.cycleId);
        }
      } catch (error) {
        // The instruction is not visible to this party (MainNet) or the ledger is busy: try again
        // on the next pass. A 404 is expected there and is not worth a failure.
        if (!(error instanceof LedgerError)) throw error;
      }
    }
    return report;
  }

  async function pass(): Promise<ReconcileReport> {
    const report = EMPTY();
    await deps.cycles.recoverStale().catch(() => undefined);
    for (const cycleId of await deps.cycles.waitingCycleIds().catch(() => [] as string[])) {
      const result = await deps.cycles.advance(cycleId).catch(() => 'failed' as const);
      if (result === 'executed') report.executed.push(cycleId);
    }
    const payments = await reconcilePayments().catch(() => EMPTY());
    report.accepted.push(...payments.accepted);
    report.declined.push(...payments.declined);
    if (deps.sealer) {
      for (const sealId of await deps.sealer.pending().catch(() => [] as string[])) {
        const advanced = await deps.sealer.advance(sealId).then(
          () => true,
          () => false,
        );
        if (advanced) report.sealsAdvanced.push(sealId);
      }
    }
    return report;
  }

  function reconcileOnce(): Promise<ReconcileReport> {
    // Single flight: a pass that is already running is shared, never doubled.
    running ??= pass().finally(() => {
      running = undefined;
    });
    return running;
  }

  function loop(delay: number): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void reconcileOnce()
        .catch(() => undefined)
        .finally(() => loop(intervalMs));
    }, delay);
    timer.unref();
  }

  return {
    reconcileOnce,
    reconcilePayments: () => reconcilePayments(),
    start() {
      if (!stopped) return;
      stopped = false;
      loop(Math.min(intervalMs, 1000));
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** Creates the reconciler and starts its loop (every 10 s by default). `stop()` ends it. */
export function startReconciler(deps: ReconcilerDeps, intervalMs = 10_000): Reconciler {
  const reconciler = createReconciler(deps, intervalMs);
  reconciler.start();
  return reconciler;
}
