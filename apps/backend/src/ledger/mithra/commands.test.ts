import { describe, expect, it } from 'vitest';
import type { Transaction } from '../types';
import { choiceResults, createMithraCommands, type ProposalInput } from './commands';
import { mithraTemplateIds, type MandateTerms, type TransferLeg } from './templates';

const commands = createMithraCommands(mithraTemplateIds('#mithra-v1'));

const terms: MandateTerms = {
  cap: '5000.0000000000',
  approvers: ['a1', 'a2'],
  approvalThreshold: 2,
  asset: { admin: 'dso', id: 'Amulet' },
  scheduleCron: '0 9 1 * *',
  scheduleTimezone: 'UTC',
  recordDateRule: 'last_day_of_previous_month',
  fixedAmount: null,
  deviationPct: '50',
  trailingCycles: 3,
  unitChangePct: '25',
  unitChangeWindowDays: 30,
  feeBuffer: '1',
};

describe('exercise builders', () => {
  it('builds Charter_CreateOrganization with the Int as a string', () => {
    expect(
      commands.charterCreateOrganization('00c1', {
        name: 'Acme',
        asset: { admin: 'dso', id: 'Amulet' },
        approvers: ['a1', 'a2'],
        approvalThreshold: 2,
      }),
    ).toEqual({
      ExerciseCommand: {
        templateId: '#mithra-v1:Mithra.Charter:TreasuryCharter',
        contractId: '00c1',
        choice: 'Charter_CreateOrganization',
        choiceArgument: {
          name: 'Acme',
          asset: { admin: 'dso', id: 'Amulet' },
          approvers: ['a1', 'a2'],
          approvalThreshold: '2',
        },
      },
    });
  });

  it('encodes Org_IssueUnits, Org_ApplySeal with None as null, and Org_GrantAccess variants', () => {
    expect(
      commands.orgIssueUnits('00o', {
        registerCid: '00r',
        holder: 'h',
        units: 100,
        effectiveDate: '2026-01-15',
        seeded: true,
      }).ExerciseCommand.choiceArgument,
    ).toEqual({
      registerCid: '00r',
      holder: 'h',
      units: '100',
      effectiveDate: '2026-01-15',
      seeded: true,
    });
    expect(
      commands.orgApplySeal('00o', { sealRequestCid: '00s', currentMandateCid: null })
        .ExerciseCommand.choiceArgument,
    ).toEqual({ sealRequestCid: '00s', currentMandateCid: null });
    expect(
      commands.orgApplySeal('00o', { sealRequestCid: '00s', currentMandateCid: '00m' })
        .ExerciseCommand.choiceArgument,
    ).toEqual({ sealRequestCid: '00s', currentMandateCid: '00m' });
    const grant = commands.orgGrantAccess('00o', {
      requestCid: '00q',
      expiresAt: new Date('2026-10-02T00:00:00Z'),
      evidence: [
        { tag: 'RefDecision', value: '00d' },
        { tag: 'RefOutcome', value: '00x' },
      ],
    });
    expect(grant.ExerciseCommand.choiceArgument).toEqual({
      requestCid: '00q',
      expiresAt: '2026-10-02T00:00:00.000Z',
      evidence: [
        { tag: 'RefDecision', value: '00d' },
        { tag: 'RefOutcome', value: '00x' },
      ],
    });
  });

  it('encodes Mandate_Propose with every amount as a string and Ints as strings', () => {
    const input: ProposalInput = {
      cycleId: '2026-09',
      cycleLabel: 'September 2026',
      attempt: 1,
      total: '5000',
      recordDate: '2026-09-30',
      trigger: 'TriggerSchedule',
      triggerDetail: 'Monthly',
      payouts: [{ holder: 'h1', units: 100, amount: '5000.0000000000' }],
      registerCid: '00r',
      inputFingerprints: [{ label: 'register', sha256: 'ab' }],
      checks: [
        {
          code: 'cap',
          label: 'Cap',
          passed: true,
          blocking: true,
          actual: '5,000 CC',
          limit: '5,000 CC',
          source: 'deterministic',
        },
      ],
      memo: 'm',
      memoSource: 'ai',
      modelFingerprints: [],
      seeded: false,
    };
    const { choiceArgument } = commands.mandatePropose('00m', input).ExerciseCommand;
    expect(choiceArgument).toEqual({
      input: {
        cycleId: '2026-09',
        cycleLabel: 'September 2026',
        attempt: '1',
        total: '5000',
        recordDate: '2026-09-30',
        trigger: 'TriggerSchedule',
        triggerDetail: 'Monthly',
        payouts: [{ holder: 'h1', units: '100', amount: '5000.0000000000' }],
        registerCid: '00r',
        inputFingerprints: [{ label: 'register', sha256: 'ab' }],
        checks: [
          {
            code: 'cap',
            label: 'Cap',
            passed: true,
            blocking: true,
            actual: '5,000 CC',
            limit: '5,000 CC',
            source: 'deterministic',
          },
        ],
        memo: 'm',
        memoSource: 'ai',
        modelFingerprints: [],
        seeded: false,
      },
    });
    expect(() => commands.mandatePropose('00m', { ...input, total: '1e3' })).toThrow();
    expect(() => commands.mandatePropose('00m', { ...input, attempt: 1.5 })).toThrow();
  });

  it('encodes execute legs with the registry choice context', () => {
    const leg: TransferLeg = {
      holder: 'h1',
      factoryCid: '00f',
      extraArgs: {
        context: { values: { 'amulet-rules': { tag: 'AV_ContractId', value: '00z' } } },
        meta: { values: {} },
      },
    };
    const agent = commands.mandateAgentExecute('00m', {
      proposalCid: '00p',
      legs: [leg],
      inputHoldingCids: ['00h'],
      executeBefore: new Date('2026-10-02T00:00:00Z'),
    });
    expect(agent.ExerciseCommand.choice).toBe('Mandate_AgentExecute');
    expect(agent.ExerciseCommand.choiceArgument).toEqual({
      proposalCid: '00p',
      legs: [
        {
          holder: 'h1',
          factoryCid: '00f',
          extraArgs: {
            context: { values: { 'amulet-rules': { tag: 'AV_ContractId', value: '00z' } } },
            meta: { values: {} },
          },
        },
      ],
      inputHoldingCids: ['00h'],
      executeBefore: '2026-10-02T00:00:00.000Z',
    });
    expect(
      commands.mandateTreasuryExecute('00m', {
        proposalCid: '00p',
        legs: [],
        inputHoldingCids: [],
        executeBefore: '2026-10-02T00:00:00Z',
      }).ExerciseCommand.choice,
    ).toBe('Mandate_TreasuryExecute');
  });

  it('builds the simple choices on the right templates', () => {
    const cases: [ReturnType<typeof commands.proposalCancel>, string, string][] = [
      [
        commands.proposalApprove('00p', { approver: 'a', note: 'n' }),
        'Mithra.Proposal:Proposal',
        'Proposal_Approve',
      ],
      [
        commands.proposalReject('00p', { approver: 'a', reason: 'r' }),
        'Mithra.Proposal:Proposal',
        'Proposal_Reject',
      ],
      [commands.proposalCancel('00p'), 'Mithra.Proposal:Proposal', 'Proposal_Cancel'],
      [commands.fundUnitAccept('00u'), 'Mithra.Units:FundUnit', 'FundUnit_Accept'],
      [commands.paymentMarkAccepted('00y'), 'Mithra.Payment:Payment', 'Payment_MarkAccepted'],
      [
        commands.paymentRecordExternal('00y', { txRef: '1220ab', status: 'Paid' }),
        'Mithra.Payment:Payment',
        'Payment_RecordExternal',
      ],
      [
        commands.mandateAuthorizeExternalPayout('00m', { proposalCid: '00p', receivers: [] }),
        'Mithra.Mandate:Mandate',
        'Mandate_AuthorizeExternalPayout',
      ],
      [
        commands.accessGrantCloseExpired('00g', { closer: 'c' }),
        'Mithra.Audit:AccessGrant',
        'AccessGrant_CloseExpired',
      ],
      [commands.accessGrantRevoke('00g'), 'Mithra.Audit:AccessGrant', 'AccessGrant_Revoke'],
      [commands.auditRequestWithdraw('00q'), 'Mithra.Audit:AuditRequest', 'AuditRequest_Withdraw'],
      [
        commands.sealRequestWithdraw('00s'),
        'Mithra.Mandate:MandateSealRequest',
        'SealRequest_Withdraw',
      ],
      [
        commands.orgDenyAccess('00o', { requestCid: '00q', reason: 'no' }),
        'Mithra.Org:Organization',
        'Org_DenyAccess',
      ],
      [
        commands.orgAcceptDeposit('00o', {
          instructionCid: '00i',
          extraArgs: { context: { values: {} }, meta: { values: {} } },
        }),
        'Mithra.Org:Organization',
        'Org_AcceptDeposit',
      ],
    ];
    for (const [command, entity, choice] of cases) {
      expect(command.ExerciseCommand.templateId).toBe(`#mithra-v1:${entity}`);
      expect(command.ExerciseCommand.choice).toBe(choice);
    }
  });
});

describe('create builders', () => {
  it('builds the five creates', () => {
    const treasury = { treasury: 't', treasurer: 'r', agent: 'g' };
    expect(commands.createTreasuryCharter({ ...treasury, operator: 'o' }).CreateCommand).toEqual({
      templateId: '#mithra-v1:Mithra.Charter:TreasuryCharter',
      createArguments: { ...treasury, operator: 'o' },
    });
    const seal = commands.createMandateSealRequest({
      ...treasury,
      terms,
      agentExecutes: true,
      summary: 's',
      summaryFingerprint: 'ff',
      requestedAt: '2026-10-01T09:00:00Z',
    }).CreateCommand;
    expect(seal.templateId).toBe('#mithra-v1:Mithra.Mandate:MandateSealRequest');
    expect(seal.createArguments).toMatchObject({
      requestedAt: '2026-10-01T09:00:00.000Z',
      terms: {
        approvalThreshold: '2',
        trailingCycles: '3',
        fixedAmount: null,
        cap: '5000.0000000000',
      },
    });
    const audit = commands.createAuditRequest({
      auditor: 'u',
      ...treasury,
      requestId: 'req-1',
      question: 'q',
      scope: [{ recordId: 'decision/1/1', kind: 'decision', reason: 'why' }],
      excluded: 'x',
      requestedAt: new Date('2026-10-01T09:00:00Z'),
    }).CreateCommand;
    expect(audit.templateId).toBe('#mithra-v1:Mithra.Audit:AuditRequest');
    expect(
      commands.createCharterProposal({
        governanceParty: 't',
        proposer: 'o',
        treasurer: 'r',
        agent: 'g',
        operator: 'o',
      }).CreateCommand.templateId,
    ).toBe('#mithra-v1:Mithra.Governance:CharterProposal');
    expect(
      commands.createMandateChangeProposal({
        governanceParty: 't',
        proposer: 'o',
        orgCid: '00o',
        sealRequestCid: '00s',
        currentMandateCid: null,
        description: 'd',
      }).CreateCommand.createArguments,
    ).toMatchObject({ currentMandateCid: null });
  });
});

describe('choice results', () => {
  const tx = (choice: string, exerciseResult: unknown): Transaction => ({
    updateId: 'u',
    offset: 1,
    effectiveAt: '2026-10-01T00:00:00Z',
    recordTime: '',
    synchronizerId: '',
    events: [
      {
        kind: 'exercised',
        contractId: '00x',
        templateId: 'pkg:M:E',
        entity: 'M:E',
        choice,
        choiceArgument: {},
        exerciseResult,
        consuming: false,
        actingParties: [],
      },
    ],
  });

  it('reads tuples from { _1, _2 } and plain contract ids', () => {
    expect(
      choiceResults.charterCreateOrganization(
        tx('Charter_CreateOrganization', { _1: '00a', _2: '00b' }),
      ),
    ).toEqual({
      orgCid: '00a',
      registerCid: '00b',
    });
    expect(
      choiceResults.mandatePropose(
        tx('Mandate_Propose', { mandateCid: '00m', proposalCid: '00p', decisionRecordCid: '00d' }),
      ),
    ).toEqual({
      mandateCid: '00m',
      proposalCid: '00p',
      decisionRecordCid: '00d',
    });
    expect(
      choiceResults.mandateAgentExecute(tx('Mandate_AgentExecute', { _1: '00m', _2: '00o' })),
    ).toEqual({
      mandateCid: '00m',
      outcomeCid: '00o',
    });
    expect(choiceResults.orgGrantAccess(tx('Org_GrantAccess', '00g'))).toEqual({ grantCid: '00g' });
  });

  it('fails clearly when the shape is wrong or the choice is missing', () => {
    expect(() => choiceResults.mandatePropose(tx('Mandate_Propose', ['00p', '00d']))).toThrow();
    expect(() =>
      choiceResults.mandatePropose(tx('Mandate_Propose', { _1: '00p', _2: '00d' })),
    ).toThrow();
    expect(() => choiceResults.orgApplySeal(tx('Mandate_Propose', {}))).toThrow(/LEDGER_EFFECTS/);
  });
});
