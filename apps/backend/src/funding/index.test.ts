import { describe, expect, it } from 'vitest';
import {
  createMithraCommands,
  mithraTemplateIds,
  type DisclosedContract,
  type Ledger,
  type SubmitInput,
  type Transaction,
} from '../ledger';
import { localnetTestConfig } from '../testConfig';
import type { AssetAdapter } from '../wallet';
import {
  FundingError,
  TRANSFER_FACTORY_INTERFACE,
  createFunding,
  deriveScanUrl,
  deriveValidatorUrl,
  toLedgerCommand,
  type AmuletSdk,
} from './index';

const config = localnetTestConfig();
const { operator, treasury, agent } = config.parties;

const EMPTY = { context: { values: {} }, meta: { values: {} } };
const tapDisclosed = {
  templateId: 'pkg:Splice.AmuletRules:AmuletRules',
  contractId: 'rules-1',
  createdEventBlob: 'blob-rules',
  synchronizerId: 'sync-1',
};
const tapCommand = {
  ExerciseCommand: {
    templateId: 'pkg:Splice.AmuletRules:AmuletRules',
    contractId: 'rules-1',
    choice: 'AmuletRules_DevNet_Tap',
    choiceArgument: { receiver: operator, amount: '10000' },
  },
};

function tx(updateId: string, events: Transaction['events'] = []): Transaction {
  return { updateId, offset: 1, effectiveAt: '', recordTime: '', synchronizerId: 's', events };
}

function transferTx(output: unknown): Transaction {
  return tx('upd-transfer', [
    {
      kind: 'exercised',
      contractId: 'factory-1',
      templateId: 'x',
      entity: 'x',
      choice: 'TransferFactory_Transfer',
      choiceArgument: {},
      exerciseResult: { output, senderChangeCids: [], meta: { values: {} } },
      consuming: false,
      actingParties: [operator],
    },
  ]);
}

interface Setup {
  submits: SubmitInput[];
  tapCalls: [string, string][];
  preapprovalCalls: string[];
  accepted: string[];
  legAmounts: string[];
}

interface PendingTransfer {
  cid: string;
  amount: string;
  sender?: string;
  receiver?: string;
}

function setup(
  options: {
    output?: unknown;
    org?: boolean;
    holdings?: string[];
    /** The operator's balance as the asset adapter reports it. Default 0. */
    balance?: string;
    /** Transfers waiting for the treasury on the ledger. */
    pending?: PendingTransfer[];
  } = {},
) {
  const state: Setup = {
    submits: [],
    tapCalls: [],
    preapprovalCalls: [],
    accepted: [],
    legAmounts: [],
  };
  const sdk: AmuletSdk = {
    amulet: {
      tap(party, amount) {
        state.tapCalls.push([party, amount]);
        return Promise.resolve([tapCommand, [tapDisclosed]] as const);
      },
      preapproval: {
        command: {
          create(args) {
            state.preapprovalCalls.push(args.parties.receiver);
            return Promise.resolve({
              CreateCommand: {
                templateId: 'pkg:Splice.AmuletRules:TransferPreapprovalProposal',
                createArguments: { receiver: args.parties.receiver },
              },
            });
          },
        },
      },
    },
  };
  const results: Transaction[] = [];
  const client = {
    activeContracts: () =>
      Promise.resolve(
        (options.pending ?? []).map((p) => ({
          contractId: p.cid,
          templateId: 'pkg:Splice.Instruction:Instruction',
          entity: 'Splice.Instruction:Instruction',
          payload: {},
          signatories: [],
          observers: [],
          createdAt: '',
          offset: 1,
          synchronizerId: 's',
          interfaceViews: [
            {
              interfaceId: `pkgid:Splice.Api.Token.TransferInstructionV1:TransferInstruction`,
              viewValue: {
                transfer: {
                  sender: p.sender ?? operator,
                  receiver: p.receiver ?? treasury,
                  amount: p.amount,
                  instrumentId: { admin: 'dso::1220aa', id: 'Amulet' },
                },
              },
            },
          ],
        })),
      ),
    submit(input: SubmitInput) {
      state.submits.push(input);
      const next =
        input.shape === 'LEDGER_EFFECTS'
          ? transferTx(
              options.output ?? {
                tag: 'TransferInstructionResult_Pending',
                value: { transferInstructionCid: 'ti-1' },
              },
            )
          : tx(`upd-${state.submits.length}`);
      results.push(next);
      return Promise.resolve(next);
    },
  };
  const commands = createMithraCommands(mithraTemplateIds('#mithra-v1'));
  const reader = {
    organization: () =>
      Promise.resolve(
        options.org === false ? null : { contractId: 'org-1', createdAt: '', payload: {} as never },
      ),
  };
  const factoryDisclosed: DisclosedContract = {
    templateId: 'pkg:Splice.TransferFactory',
    contractId: 'factory-1',
    createdEventBlob: 'blob-factory',
    synchronizerId: 'sync-1',
  };
  const asset: AssetAdapter = {
    instrument: () => ({ admin: 'dso::1220aa', id: 'Amulet' }),
    holdings: (party) =>
      Promise.resolve(
        (options.holdings ?? ['2000', '10000', '500']).map((amount, i) => ({
          contractId: `h-${String(i)}-${amount}`,
          owner: party,
          instrument: { admin: 'dso::1220aa', id: 'Amulet' },
          amount,
          locked: false,
        })),
      ),
    balance: () => Promise.resolve(options.balance ?? '0'),
    transferLeg: (input) => {
      expect(input).toMatchObject({ sender: operator, receiver: treasury });
      state.legAmounts.push(input.amount);
      return Promise.resolve({
        kind: 'offer' as const,
        disclosed: [factoryDisclosed],
        leg: { holder: treasury, factoryCid: 'factory-1', extraArgs: EMPTY },
      });
    },
    acceptContext: (cid) => {
      state.accepted.push(cid);
      return Promise.resolve({
        extraArgs: EMPTY,
        disclosed: [{ ...factoryDisclosed, contractId: 'ctx-1' }],
      });
    },
  };
  const funding = createFunding({
    config,
    ledger: { client, reader, commands } as unknown as Pick<
      Ledger,
      'client' | 'reader' | 'commands'
    >,
    asset,
    sdk: () => Promise.resolve(sdk),
    now: () => new Date('2026-10-01T12:00:00Z'),
  });
  return { funding, state };
}

describe('fundTreasury', () => {
  it('taps to the operator, sends to the treasury and has the agent accept the pending transfer', async () => {
    const { funding, state } = setup();
    const result = await funding.fundTreasury('10000');

    // (1) Tap: built by the SDK, submitted as the operator with the SDK's disclosed contracts.
    expect(state.tapCalls).toEqual([[operator, '10000']]);
    const [tap, transfer, accept] = state.submits;
    expect(tap).toMatchObject({ actAs: [operator], commands: [tapCommand] });
    expect(tap?.disclosedContracts).toEqual([tapDisclosed]);

    // (2) TransferFactory_Transfer through the interface, operator to treasury, largest holdings first.
    expect(transfer?.actAs).toEqual([operator]);
    expect(transfer?.shape).toBe('LEDGER_EFFECTS');
    expect(transfer?.disclosedContracts?.map((d) => d.contractId)).toEqual(['factory-1']);
    const exercise = transfer?.commands[0];
    expect(exercise).toMatchObject({
      ExerciseCommand: {
        templateId: TRANSFER_FACTORY_INTERFACE,
        contractId: 'factory-1',
        choice: 'TransferFactory_Transfer',
        choiceArgument: {
          expectedAdmin: 'dso::1220aa',
          transfer: {
            sender: operator,
            receiver: treasury,
            amount: '10000',
            instrumentId: { admin: 'dso::1220aa', id: 'Amulet' },
            // 10000 alone covers the amount, so only the largest holding is used.
            inputHoldingCids: ['h-1-10000'],
            requestedAt: '2026-10-01T11:59:00.000Z',
            executeBefore: '2026-10-02T12:00:00.000Z',
          },
          extraArgs: EMPTY,
        },
      },
    });

    // (3) Org_AcceptDeposit as the agent, reading as the treasury, with the accept context.
    expect(state.accepted).toEqual(['ti-1']);
    expect(accept).toMatchObject({ actAs: [agent], readAs: [treasury] });
    expect(accept?.commands[0]).toMatchObject({
      ExerciseCommand: {
        contractId: 'org-1',
        choice: 'Org_AcceptDeposit',
        choiceArgument: { instructionCid: 'ti-1', extraArgs: EMPTY },
      },
    });
    expect(accept?.disclosedContracts?.map((d) => d.contractId)).toEqual(['ctx-1']);
    expect(result).toEqual({
      amount: '10000',
      acceptedPending: true,
      tapUpdateId: 'upd-1',
      transferUpdateId: 'upd-transfer',
      acceptUpdateId: 'upd-3',
    });
  });

  it('does not tap again when the operator already holds the funds from an earlier attempt', async () => {
    const { funding, state } = setup({ balance: '10000' });
    const result = await funding.fundTreasury('10000');
    expect(state.tapCalls).toEqual([]);
    expect(state.submits.map((s) => s.actAs)).toEqual([[operator], [agent]]); // transfer, accept
    expect(state.legAmounts).toEqual(['10000']);
    expect(result).toMatchObject({ tapUpdateId: null, acceptedPending: true });
    // Less than the amount is not enough: the tap runs.
    const short = setup({ balance: '9999.9999999999' });
    await short.funding.fundTreasury('10000');
    expect(short.state.tapCalls).toEqual([[operator, '10000']]);
  });

  it('accepts a transfer already waiting for the treasury first, and neither taps nor sends again when it covers the amount', async () => {
    const { funding, state } = setup({ pending: [{ cid: 'ti-earlier', amount: '10000' }] });
    const result = await funding.fundTreasury('10000');
    expect(state.accepted).toEqual(['ti-earlier']);
    expect(state.tapCalls).toEqual([]);
    expect(state.submits).toHaveLength(1);
    expect(state.submits[0]).toMatchObject({
      actAs: [agent],
      readAs: [treasury],
      commands: [{ ExerciseCommand: { choice: 'Org_AcceptDeposit' } }],
    });
    expect(result).toEqual({
      amount: '10000',
      acceptedPending: true,
      tapUpdateId: null,
      transferUpdateId: null,
      acceptUpdateId: 'upd-1',
    });
  });

  it('funds only the rest when the waiting transfer is smaller than the amount', async () => {
    const { funding, state } = setup({ pending: [{ cid: 'ti-earlier', amount: '4000' }] });
    await funding.fundTreasury('10000');
    expect(state.accepted).toEqual(['ti-earlier', 'ti-1']);
    expect(state.tapCalls).toEqual([[operator, '6000.0000000000']]);
    expect(state.legAmounts).toEqual(['6000.0000000000']);
  });

  it('ignores transfers that are not from the operator to the treasury', async () => {
    const { funding, state } = setup({
      pending: [
        { cid: 'ti-other-sender', amount: '10000', sender: 'someone::1220aa' },
        { cid: 'ti-other-receiver', amount: '10000', receiver: 'holder-a::1220aa' },
      ],
    });
    await funding.fundTreasury('10000');
    expect(state.accepted).toEqual(['ti-1']);
    expect(state.tapCalls).toEqual([[operator, '10000']]);
  });

  it('says what happens on a retry when a waiting transfer cannot be accepted without an organization', async () => {
    const { funding, state } = setup({
      org: false,
      pending: [{ cid: 'ti-earlier', amount: '10000' }],
    });
    await expect(funding.fundTreasury('10000')).rejects.toThrow(/does not tap again/);
    expect(state.tapCalls).toEqual([]);
    expect(state.submits).toEqual([]);
  });

  it('adds up several holdings when one is not enough', async () => {
    const { funding, state } = setup({ holdings: ['6000', '5000', '10'] });
    await funding.fundTreasury('10000');
    const exercise = state.submits[1]?.commands[0];
    expect(exercise).toMatchObject({
      ExerciseCommand: {
        choiceArgument: { transfer: { inputHoldingCids: ['h-0-6000', 'h-1-5000'] } },
      },
    });
  });

  it('stops after the transfer when the registry completed it in one step', async () => {
    const { funding, state } = setup({
      output: { tag: 'TransferInstructionResult_Completed', value: { receiverHoldingCids: ['h'] } },
    });
    const result = await funding.fundTreasury('10000');
    expect(state.submits).toHaveLength(2);
    expect(result).toMatchObject({ acceptedPending: false, acceptUpdateId: null });
  });

  it('says what to do when the registry refuses, when holdings are short or the org is missing', async () => {
    await expect(
      setup({
        output: { tag: 'TransferInstructionResult_Failed', value: {} },
      }).funding.fundTreasury('10000'),
    ).rejects.toThrow(/refused the transfer to the treasury/);
    await expect(setup({ holdings: ['5'] }).funding.fundTreasury('10000')).rejects.toThrow(
      /Check that the tap worked/,
    );
    await expect(setup({ org: false }).funding.fundTreasury('10000')).rejects.toThrow(
      /Create the organization first/,
    );
    await expect(setup().funding.fundTreasury('10 CC')).rejects.toThrow();
  });
});

describe('createPreapproval', () => {
  it('has the SDK build the command and submits it as the receiver', async () => {
    const { funding, state } = setup();
    await funding.createPreapproval('holder-b::1220aa');
    expect(state.preapprovalCalls).toEqual(['holder-b::1220aa']);
    expect(state.submits).toHaveLength(1);
    expect(state.submits[0]).toMatchObject({
      actAs: ['holder-b::1220aa'],
      commands: [
        {
          CreateCommand: {
            templateId: 'pkg:Splice.AmuletRules:TransferPreapprovalProposal',
            createArguments: { receiver: 'holder-b::1220aa' },
          },
        },
      ],
    });
  });
});

describe('SDK output checks', () => {
  it('rejects a command shape it does not know, naming the SDK', () => {
    expect(() => toLedgerCommand({ Oops: {} }, 'tap')).toThrow(FundingError);
    expect(() => toLedgerCommand({ Oops: {} }, 'tap')).toThrow(/wallet-sdk/);
    expect(toLedgerCommand(tapCommand, 'tap')).toEqual(tapCommand);
  });

  it('retries building the SDK after a failure', async () => {
    let attempts = 0;
    const flaky = createFunding({
      config,
      ledger: {} as never,
      asset: {} as never,
      sdk: () => {
        attempts += 1;
        return Promise.reject(new Error('validator down'));
      },
    });
    await expect(flaky.createPreapproval('x')).rejects.toThrow('validator down');
    await expect(flaky.createPreapproval('x')).rejects.toThrow('validator down');
    expect(attempts).toBe(2);
  });
});

describe('URL derivation', () => {
  it('derives the validator URL from REGISTRY_URL', () => {
    expect(deriveValidatorUrl('http://localhost:2000/api/validator/v0/scan-proxy')).toBe(
      'http://localhost:2000/api/validator',
    );
    expect(deriveValidatorUrl('http://localhost:2000/api/validator/v0/scan-proxy/')).toBe(
      'http://localhost:2000/api/validator',
    );
    expect(() => deriveValidatorUrl('https://registry.example/api')).toThrow(/REGISTRY_URL/);
  });

  it('prefers an explicit scan URL, then LocalNet scan for localhost, then the validator origin', () => {
    expect(
      deriveScanUrl('http://localhost:2000/api/validator', 'http://scan.example/api/scan'),
    ).toBe('http://scan.example/api/scan');
    expect(deriveScanUrl('http://localhost:2000/api/validator')).toBe(
      'http://scan.localhost:4000/api/scan',
    );
    expect(deriveScanUrl('https://validator.example/api/validator')).toBe(
      'https://validator.example/api/scan',
    );
  });
});
