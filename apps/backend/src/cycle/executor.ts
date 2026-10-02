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

/** Submits the ledger payout (`Mandate_AgentExecute`); the ledger rail's only collaborator that writes. */
export interface PayoutExecutor {
  execute(request: ExecuteRequest): Promise<Transaction>;
}

/** `Mandate_AgentExecute` as the agent, server-side. */
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
