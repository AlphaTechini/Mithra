import { formatDecimal, toDecimal, type MainnetPayoutStatus } from '@mithra/shared';
import type {
  Contract,
  DisclosedContract,
  Ledger,
  Mandate,
  PaymentStatus,
  Proposal,
  Transaction,
  TransferLeg,
} from '../ledger';
import type { MainnetWalletLookup } from '../mainnet/wallets';
import type { AssetAdapter } from '../wallet';
import type { PayoutExecutor } from './executor';
import { D } from './format';

/**
 * How a ready proposal turns into payments. Two rails:
 * - `ledger` (LocalNet): `Mandate_AgentExecute` moves the asset on the records ledger itself.
 * - `grofty-mainnet`: the records stay on the ledger, but the money moves on Canton MainNet in
 *   plain CC transfers the treasurer signs in Grofty Wallet. The Mandate's rules (cap, pro rata,
 *   one payout per cycle, approval threshold) still decide on the ledger, in
 *   `Mandate_AuthorizeExternalPayout`, before any transfer is offered for signing.
 */
export type PayoutRailKind = 'ledger' | 'grofty-mainnet';

export interface RailRequest {
  cycleId: string;
  label: string;
  proposal: Contract<Proposal>;
  mandate: Contract<Mandate>;
}

export interface RailHooks {
  /** Called once the rail starts submitting to the ledger, for the timeline. */
  announce(): Promise<void>;
}

export type RailResult =
  /** The ledger moved the money and recorded the payments. */
  | { kind: 'paid'; tx: Transaction }
  /** The ledger authorized the payout; the payments wait for the treasurer's signatures in Grofty. */
  | { kind: 'authorized'; tx: Transaction }
  /** P5: the live balance is below the total plus the fee buffer. */
  | { kind: 'needs-funds'; balance: string; required: string }
  /** Some payees have not connected a MainNet wallet yet. */
  | { kind: 'needs-wallets'; holders: string[] };

export interface PayoutRail {
  readonly kind: PayoutRailKind;
  run(request: RailRequest, hooks: RailHooks): Promise<RailResult>;
}

type Lock = <T>(fn: () => Promise<T>) => Promise<T>;

export interface LedgerRailDeps {
  assets: AssetAdapter;
  executor: PayoutExecutor;
  treasury: string;
  executeWindowMs: number;
  now: () => Date;
  /** Serializes submissions that consume the Mandate. */
  lock: Lock;
}

/**
 * The ledger rail (unchanged behavior on LocalNet): checks the live balance against the total plus
 * the fee buffer (P5), selects input holdings, builds one transfer per payout with the asset
 * adapter and submits `Mandate_AgentExecute` with a command id that makes a retry safe.
 */
export class LedgerPayoutRail implements PayoutRail {
  readonly kind = 'ledger' as const;

  constructor(private readonly deps: LedgerRailDeps) {}

  async run(request: RailRequest, hooks: RailHooks): Promise<RailResult> {
    const { assets, treasury } = this.deps;
    const { proposal, mandate } = request;
    // P5: the live balance must cover the total plus the fee buffer.
    const total = toDecimal(proposal.payload.total);
    const required = total.plus(toDecimal(mandate.payload.terms.feeBuffer));
    const balance = await assets.balance(treasury);
    if (toDecimal(balance).lt(required)) {
      return {
        kind: 'needs-funds',
        balance: formatDecimal(toDecimal(balance)),
        required: formatDecimal(required),
      };
    }

    await hooks.announce();

    const holdings = (await assets.holdings(treasury))
      .filter((h) => !h.locked)
      .sort((a, b) => toDecimal(b.amount).comparedTo(toDecimal(a.amount)));
    const inputs: string[] = [];
    let covered = new D(0);
    for (const holding of holdings) {
      if (covered.gte(required)) break;
      inputs.push(holding.contractId);
      covered = covered.plus(toDecimal(holding.amount));
    }
    const legResults = await Promise.all(
      proposal.payload.payouts.map((p) =>
        assets.transferLeg({ sender: treasury, receiver: p.holder, amount: p.amount }),
      ),
    );
    const legs: TransferLeg[] = legResults.map((r) => r.leg);
    const disclosed = new Map<string, DisclosedContract>();
    for (const r of legResults) for (const d of r.disclosed) disclosed.set(d.contractId, d);

    const tx = await this.deps.lock(() =>
      this.deps.executor.execute({
        mandateCid: mandate.contractId,
        proposalCid: proposal.contractId,
        legs,
        inputHoldingCids: inputs,
        disclosed: [...disclosed.values()],
        commandId: `execute-${proposal.payload.proposalId}`,
        executeBefore: new Date(this.deps.now().getTime() + this.deps.executeWindowMs),
      }),
    );
    return { kind: 'paid', tx };
  }
}

export interface GroftyRailDeps {
  ledger: Pick<Ledger, 'client' | 'commands'>;
  agent: string;
  /** Parties the agent reads as when submitting (the treasury, when the ledger user may). */
  readAs: string[];
  wallets: Pick<MainnetWalletLookup, 'all'>;
  lock: Lock;
}

/**
 * The MainNet rail. It never moves money and never sees the treasurer's balance (that lives in
 * their Grofty wallet and is checked in the browser, P5). It only asks the ledger to authorize the
 * payout with each payee's registered MainNet party; the payments then wait, `PendingExternal`,
 * until the treasurer's transfers are recorded (`mainnet/payouts.ts`).
 */
export class GroftyMainnetRail implements PayoutRail {
  readonly kind = 'grofty-mainnet' as const;

  constructor(private readonly deps: GroftyRailDeps) {}

  /**
   * What a recorded transfer becomes on the ledger. `unknown` is Grofty confirming the transfer
   * while the app could not read whether the receiver already holds the funds: it counts as Paid
   * (the transfer executed) and the activity line says acceptance could not be read.
   */
  static recordedStatus(
    outcome: 'completed' | 'pending' | 'unknown',
  ): 'Paid' | 'AwaitingAcceptance' {
    return outcome === 'pending' ? 'AwaitingAcceptance' : 'Paid';
  }

  /** How a ledger payment status shows on the payout page. */
  static payoutStatus(status: PaymentStatus): MainnetPayoutStatus {
    switch (status) {
      case 'Paid':
        return 'paid';
      case 'AwaitingAcceptance':
        return 'awaiting-acceptance';
      case 'PendingExternal':
        return 'to-sign';
    }
  }

  async run(request: RailRequest, hooks: RailHooks): Promise<RailResult> {
    const { proposal, mandate } = request;
    const wallets = await this.deps.wallets.all();
    const payees = proposal.payload.payouts.map((p) => p.holder);
    const missing = payees.filter((holder) => !wallets.has(holder));
    if (missing.length > 0) return { kind: 'needs-wallets', holders: missing };

    await hooks.announce();
    const receivers = payees.map((holder) => ({ holder, receiver: wallets.get(holder) ?? '' }));
    const tx = await this.deps.lock(() =>
      this.deps.ledger.client.submit({
        actAs: [this.deps.agent],
        readAs: this.deps.readAs,
        commands: [
          this.deps.ledger.commands.mandateAuthorizeExternalPayout(mandate.contractId, {
            proposalCid: proposal.contractId,
            receivers,
          }),
        ],
        // The same command id for every retry of one proposal, so the ledger authorizes it once.
        commandId: `authorize-${proposal.payload.proposalId}`,
        shape: 'LEDGER_EFFECTS',
      }),
    );
    return { kind: 'authorized', tx };
  }
}
