import { ApiError } from '../http/errors';
import type { Ledger } from '../ledger';
import type { DisclosedContract, Transaction, TransferLeg } from '../ledger';

/** Everything needed to submit the payout choice of the Mandate. */
export interface ExecuteRequest {
  mandateCid: string;
  proposalCid: string;
  legs: TransferLeg[];
  inputHoldingCids: string[];
  disclosed: DisclosedContract[];
  /** Same for every retry of one proposal, so the ledger applies the payout once. */
  commandId: string;
  executeBefore: Date;
}

/** Who signs the payout. LocalNet: the agent, server-side. MainNet: the treasurer in Grofty (M10). */
export interface PayoutExecutor {
  execute(request: ExecuteRequest): Promise<Transaction>;
}

export const MAINNET_SIGNING_MESSAGE = 'Signing in Grofty arrives with the MainNet build';

/** The payout cannot be signed by this build; the cycle waits for the treasurer's signature. */
export class AwaitingSignatureError extends ApiError {
  constructor() {
    super(409, 'awaiting_signature', MAINNET_SIGNING_MESSAGE);
    this.name = 'AwaitingSignatureError';
  }
}

/** `Mandate_AgentExecute` as the agent (LocalNet, and any Mandate that lets the agent execute). */
export class AgentPayoutExecutor implements PayoutExecutor {
  constructor(
    private readonly ledger: Pick<Ledger, 'client' | 'commands'>,
    private readonly parties: { agent: string; treasury: string },
    private readonly readAsTreasury: boolean,
  ) {}

  execute(request: ExecuteRequest): Promise<Transaction> {
    return this.ledger.client.submit({
      actAs: [this.parties.agent],
      readAs: this.readAsTreasury ? [this.parties.treasury] : [],
      commands: [
        this.ledger.commands.mandateAgentExecute(request.mandateCid, {
          proposalCid: request.proposalCid,
          legs: request.legs,
          inputHoldingCids: request.inputHoldingCids,
          executeBefore: request.executeBefore,
        }),
      ],
      disclosedContracts: request.disclosed,
      commandId: request.commandId,
      shape: 'LEDGER_EFFECTS',
    });
  }
}

/**
 * MainNet: the treasurer is the treasury and signs `Mandate_TreasuryExecute` in Grofty. M10 fills
 * this in; until then the cycle reports that it is waiting for a signature.
 */
export class TreasurerPayoutExecutor implements PayoutExecutor {
  execute(): Promise<Transaction> {
    return Promise.reject(new AwaitingSignatureError());
  }
}
