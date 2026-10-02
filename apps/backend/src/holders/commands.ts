import { encodeExtraArgs, type ExtraArgs, type LedgerCommand } from '../ledger';
import { TRANSFER_INSTRUCTION_INTERFACE } from '../funding';

/**
 * `TransferInstruction_Accept` on a pending transfer, through the token standard interface so it
 * works for any registry. Submit it as the receiver with the registry's disclosed contracts.
 */
export function transferInstructionAccept(
  instructionCid: string,
  extraArgs: ExtraArgs,
): LedgerCommand {
  return {
    ExerciseCommand: {
      templateId: TRANSFER_INSTRUCTION_INTERFACE,
      contractId: instructionCid,
      choice: 'TransferInstruction_Accept',
      choiceArgument: { extraArgs: encodeExtraArgs(extraArgs) },
    },
  };
}
