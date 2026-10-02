import {
  sumDecimals,
  type MainnetPayout,
  type MainnetPayoutsResponse,
  type RecordMainnetPayoutRequest,
  type TimelineStep,
} from '@mithra/shared';
import type { ActivityLog } from '../activity/log';
import type { Config } from '../config/env';
import type { Database } from '../db';
import { TREASURY_TEAM, type EventBus } from '../events/bus';
import { ApiError } from '../http/errors';
import { opaqueId } from '../holders/position';
import { choiceResults, type Contract, type Ledger, type Payment } from '../ledger';
import type { PartyNames } from '../parties/names';
import type { CycleService } from '../cycle/engine';
import { formatAmount, plural } from '../cycle/format';
import { txLinkFor } from '../cycle/links';
import { Mutex } from '../cycle/mutex';
import { GroftyMainnetRail } from '../cycle/rail';
import { CycleStore } from '../cycle/store';

export interface MainnetPayoutsDeps {
  config: Config;
  db: Database;
  ledger: Pick<Ledger, 'client' | 'reader' | 'commands'>;
  names: PartyNames;
  activity: ActivityLog;
  bus: EventBus;
  cycles: Pick<CycleService, 'getCycle'>;
  now?: () => Date;
}

/**
 * The treasurer's MainNet payouts: the transfers to sign in Grofty Wallet and the record of what
 * Grofty reported. The server never moves MainNet funds. A payment is "Paid" only after the
 * treasurer's browser got Grofty's executed answer and the agent recorded it
 * (`Payment_RecordExternal`, an attestation: the ledger cannot see MainNet) (P4).
 */
export class MainnetPayouts {
  private readonly store: CycleStore;
  private readonly lock = new Mutex();
  private readonly treasury: string;
  private readonly symbol: string;
  private readonly now: () => Date;

  constructor(private readonly deps: MainnetPayoutsDeps) {
    this.treasury = deps.config.parties.treasury;
    this.symbol = deps.config.asset.symbol;
    this.store = new CycleStore(deps.db, this.treasury);
    this.now = deps.now ?? (() => new Date());
  }

  private requireMainnet(): void {
    if (this.deps.config.network !== 'mainnet') {
      throw new ApiError(
        404,
        'not_available',
        'MainNet payouts are signed in Grofty Wallet; this deployment pays on LocalNet.',
      );
    }
  }

  /** The id the page uses for a payment: stable across the recreations that recording causes. */
  paymentIdOf(cycleId: string, holder: string): string {
    return opaqueId(`${this.treasury}/${cycleId}/${holder}`);
  }

  private async paymentsOf(cycleId: string): Promise<Contract<Payment>[]> {
    const all = await this.deps.ledger.reader.payments();
    return all.filter((p) => p.payload.cycleId === cycleId && p.payload.externalReceiver !== null);
  }

  async list(cycleId: string): Promise<MainnetPayoutsResponse> {
    this.requireMainnet();
    const { reader } = this.deps.ledger;
    const [payments, mandate, organization, outcomes] = await Promise.all([
      this.paymentsOf(cycleId),
      reader.mandate(),
      reader.organization(),
      reader.outcomes(),
    ]);
    if (payments.length === 0) {
      const detail = await this.deps.cycles.getCycle(cycleId);
      const reason =
        detail.summary.status === 'needs-wallets'
          ? 'Some holders have not connected Grofty Wallet yet.'
          : 'The Mandate rules have not cleared it yet (countdown, hold or approvals).';
      throw new ApiError(
        409,
        'not_ready_to_sign',
        `${detail.summary.label} has no payouts to sign yet. ${reason}`,
      );
    }
    // The payout order of the executed outcome (the pro-rata order).
    const order = new Map(
      (
        outcomes.find((o) => o.payload.cycleId === cycleId && o.payload.kind === 'Executed')
          ?.payload.payments ?? []
      ).map((r, index) => [r.holder, index]),
    );
    payments.sort(
      (a, b) => (order.get(a.payload.holder) ?? 0) - (order.get(b.payload.holder) ?? 0),
    );
    const fundName = organization?.payload.name ?? 'fund';
    const payouts: MainnetPayout[] = await Promise.all(
      payments.map(async (p) => ({
        paymentId: this.paymentIdOf(cycleId, p.payload.holder),
        holder: await this.deps.names.ref(p.payload.holder),
        receiver: p.payload.externalReceiver ?? '',
        amount: p.payload.amount,
        memo: `Mithra ${fundName} ${p.payload.cycleLabel}`,
        status: GroftyMainnetRail.payoutStatus(p.payload.status),
        link: p.payload.externalTxRef ? txLinkFor(this.deps.config, p.payload.externalTxRef) : null,
      })),
    );
    return {
      assetSymbol: this.symbol,
      total: sumDecimals(payments.map((p) => p.payload.amount)),
      feeBuffer: mandate?.payload.terms.feeBuffer ?? '0',
      payouts,
    };
  }

  /** Records what Grofty reported for one transfer. */
  record(
    cycleId: string,
    paymentId: string,
    body: RecordMainnetPayoutRequest,
    actor: string,
  ): Promise<MainnetPayoutsResponse> {
    this.requireMainnet();
    return this.lock.run(async () => {
      const { client, commands, reader } = this.deps.ledger;
      const allPayments = await reader.payments();
      const inCycle = allPayments.filter(
        (p) => p.payload.cycleId === cycleId && p.payload.externalReceiver !== null,
      );
      const payment = inCycle.find(
        (p) => this.paymentIdOf(cycleId, p.payload.holder) === paymentId,
      );
      if (!payment) {
        throw new ApiError(
          404,
          'payment_not_found',
          'That payment is not part of this cycle. Reload the page and try again.',
        );
      }
      if (payment.payload.status === 'Paid') {
        throw new ApiError(
          409,
          'already_recorded',
          'This payment is already recorded as paid. Nothing was changed.',
        );
      }
      if (
        payment.payload.status !== 'PendingExternal' &&
        payment.payload.status !== 'AwaitingAcceptance'
      ) {
        throw new ApiError(409, 'not_recordable', 'This payment cannot be recorded right now.');
      }
      const reused = allPayments.find(
        (p) => p.payload.externalTxRef === body.updateId && p.contractId !== payment.contractId,
      );
      if (reused) {
        throw new ApiError(
          409,
          'update_id_used',
          'That transaction is already recorded for another payment. Each payout needs its own transfer.',
        );
      }

      const status = GroftyMainnetRail.recordedStatus(body.outcome);
      const tx = await client.submit({
        actAs: [this.deps.config.parties.agent],
        readAs: this.deps.config.ledger.readAsTreasury ? [this.treasury] : [],
        commands: [
          commands.paymentRecordExternal(payment.contractId, { txRef: body.updateId, status }),
        ],
        shape: 'LEDGER_EFFECTS',
      });
      const { paymentCid } = choiceResults.paymentRecordExternal(tx);
      await this.store.setTxRef(paymentCid, body.updateId, 'payment');

      const holder = payment.payload.holder;
      const name = await this.deps.names.name(holder);
      const amount = formatAmount(payment.payload.amount, this.symbol);
      const label = payment.payload.cycleLabel;
      const text =
        body.outcome === 'pending'
          ? `Sent ${amount} to ${name} on MainNet (signed in Grofty); ${name} has to accept it`
          : body.outcome === 'unknown'
            ? `Paid ${amount} to ${name} on MainNet (signed in Grofty); whether it was accepted could not be read`
            : `Paid ${amount} to ${name} on MainNet (signed in Grofty)`;
      await this.deps.activity
        .record({
          actorParty: actor,
          kind: body.outcome === 'pending' ? 'payment.awaiting' : 'payment.paid',
          subject: cycleId,
          text,
          link: `/app/cycles/${cycleId}`,
          seeded: payment.payload.seeded,
          detail: { updateId: body.updateId, outcome: body.outcome, label },
        })
        .catch(() => undefined);
      this.deps.bus.publish({ type: 'holder', change: 'payments' }, { parties: [holder] });

      await this.finishIfDone(cycleId, actor);
      await this.emitStatus(cycleId);
      return this.list(cycleId);
    });
  }

  /** When every payment of the cycle is recorded, closes the "Payments" step of the timeline. */
  private async finishIfDone(cycleId: string, actor: string): Promise<void> {
    const payments = await this.paymentsOf(cycleId);
    if (payments.length === 0 || payments.some((p) => p.payload.status === 'PendingExternal')) {
      return;
    }
    const waiting = payments.filter((p) => p.payload.status === 'AwaitingAcceptance').length;
    const total = formatAmount(sumDecimals(payments.map((p) => p.payload.amount)), this.symbol);
    const first = payments[0];
    const detail =
      waiting === 0
        ? `Paid ${total} to ${plural(payments.length, 'holder')} on MainNet`
        : `Sent ${total} to ${plural(payments.length, 'holder')} on MainNet; ${waiting} awaiting acceptance`;
    const step: TimelineStep = {
      id: 'execute',
      label: 'Payments',
      status: 'done',
      detail,
      at: this.now().toISOString(),
    };
    await this.store.addTimeline(cycleId, step);
    this.deps.bus.publish({ type: 'timeline', cycleId, step }, TREASURY_TEAM);
    await this.deps.activity
      .record({
        actorParty: actor,
        kind: 'cycle.paid',
        subject: cycleId,
        text: `${first?.payload.cycleLabel ?? cycleId}: ${detail}`,
        link: `/app/cycles/${cycleId}`,
        seeded: first?.payload.seeded ?? false,
      })
      .catch(() => undefined);
  }

  private async emitStatus(cycleId: string): Promise<void> {
    try {
      const detail = await this.deps.cycles.getCycle(cycleId);
      this.deps.bus.publish(
        { type: 'cycle', cycleId, status: detail.summary.status },
        TREASURY_TEAM,
      );
    } catch {
      // A missed live update is harmless.
    }
  }
}
