import type { DisclosedContract } from '../ledger/types';
import type { ExtraArgs, InstrumentId, TransferLeg } from '../ledger/mithra/templates';

/** One holding of the distributed instrument. Amounts are decimal strings. */
export interface Holding {
  contractId: string;
  owner: string;
  instrument: InstrumentId;
  amount: string;
  /** True when the holding is locked and cannot be spent as a transfer input. */
  locked: boolean;
}

/**
 * How a transfer to one receiver will settle:
 * - `direct`: the receiver pre-approved transfers, so it completes in one step;
 * - `offer`: a pending transfer instruction the receiver must accept;
 * - `self`: sender and receiver are the same party.
 */
export type TransferKind = 'direct' | 'offer' | 'self';

export interface TransferLegInput {
  sender: string;
  receiver: string;
  /** Decimal string. */
  amount: string;
}

export interface TransferLegResult {
  leg: TransferLeg;
  /** Contracts the submission must disclose so the ledger can run the transfer. */
  disclosed: DisclosedContract[];
  kind: TransferKind;
}

/**
 * Everything the app needs from the asset's registry. One implementation per registry; the
 * token standard one covers CC and any other CIP-56 asset. Swapping the asset changes
 * configuration, not feature code.
 */
export interface AssetAdapter {
  instrument(): InstrumentId;
  holdings(party: string): Promise<Holding[]>;
  /** Sum of the party's unlocked holdings of the instrument, a decimal string. */
  balance(party: string): Promise<string>;
  transferLeg(input: TransferLegInput): Promise<TransferLegResult>;
  /** Context and disclosed contracts for accepting a pending transfer instruction. */
  acceptContext(
    instructionCid: string,
  ): Promise<{ extraArgs: ExtraArgs; disclosed: DisclosedContract[] }>;
}
