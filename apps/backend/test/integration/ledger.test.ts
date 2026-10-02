import { toDecimal } from '@mithra/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  LedgerError,
  choiceResults,
  createLedger,
  createdIn,
  type DistributionOutcome,
  type ProposalInput,
  type Transaction,
} from '../../src/ledger';
import { createTokenStandardAdapter } from '../../src/wallet';
import {
  EMPTY_EXTRA_ARGS,
  TRANSFER_INSTRUCTION_INTERFACE,
  createWorld,
  loadVectors,
  proRata,
  proposalInput,
  requireSandbox,
  submitter,
  testLeg,
  type World,
} from './helpers';

/** Compares two decimal strings as numbers of arbitrary precision. */
function sameDecimal(actual: string, expected: string): void {
  expect(toDecimal(actual).equals(toDecimal(expected)), `${actual} should equal ${expected}`).toBe(
    true,
  );
}

describe('ledger module against a Canton sandbox', () => {
  let world: World;
  let as: ReturnType<typeof submitter>;

  beforeAll(async () => {
    await requireSandbox();
    world = await createWorld();
    as = submitter(world.ledger);
  });

  it('reports the sandbox version and a connected synchronizer', async () => {
    const version = await world.ledger.client.version();
    expect(version.version).toMatch(/^3\./);
    expect((await world.ledger.client.connectedSynchronizers()).length).toBeGreaterThan(0);
    const parties = await world.ledger.client.listParties();
    expect(parties.map((p) => p.party)).toContain(world.parties.treasury);
  });

  it('reads the charter, organization, register, mandate and fund units as typed payloads', async () => {
    const { reader } = world.ledger;
    const { parties } = world;
    // Creating the organization consumed the charter.
    expect(await reader.charter()).toBeNull();
    const org = await reader.organization();
    expect(org?.payload).toMatchObject({
      treasury: parties.treasury,
      treasurer: parties.treasurer,
      name: 'Acme Fund',
      approvers: [parties.approver1, parties.approver2],
      approvalThreshold: 2,
      mandateVersion: 1,
      asset: { admin: parties.registryAdmin, id: 'CC' },
    });
    const mandate = await reader.mandate();
    expect(mandate?.payload.version).toBe(1);
    expect(mandate?.payload.agentExecutes).toBe(true);
    sameDecimal(mandate?.payload.terms.cap ?? '', '5000');
    expect(mandate?.payload.terms.cap).toMatch(/^5000(\.0+)?$/);
    expect(mandate?.payload.terms.fixedAmount).toBeNull();
    expect(mandate?.payload.terms.trailingCycles).toBe(3);
    expect(mandate?.payload.executedCycles).toEqual([]);

    const register = await reader.register();
    expect(register?.payload.changes.map((c) => [c.holder, c.delta, c.seeded])).toEqual(
      world.units.map((u) => [u.holder, u.units, false]),
    );
    expect(register?.payload.changes[0]?.effectiveDate).toBe(world.units[0]?.effectiveDate);

    const units = await reader.fundUnits();
    expect(units).toHaveLength(3);
    const unitsOfB = await reader.fundUnits(parties.holderB);
    expect(unitsOfB).toHaveLength(1);
    expect(unitsOfB[0]?.payload).toMatchObject({
      units: 300,
      accepted: false,
      orgName: 'Acme Fund',
    });
    expect(unitsOfB[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reads holdings through the Holding interface view and sums the balance as a decimal string', async () => {
    const adapter = createTokenStandardAdapter({
      ledger: world.ledger.client,
      registryUrl: 'http://localhost:1/unused',
      instrument: { admin: world.parties.registryAdmin, id: 'CC' },
    });
    const holdings = await adapter.holdings(world.parties.treasury);
    expect(holdings).toHaveLength(1);
    expect(holdings[0]).toMatchObject({ owner: world.parties.treasury, locked: false });
    sameDecimal(holdings[0]?.amount ?? '', '1000000');
    sameDecimal(await adapter.balance(world.parties.treasury), '1000000');
    sameDecimal(await adapter.balance(world.parties.holderA), '0');
  });

  it('matches the shared pro-rata vectors with decimal.js', () => {
    for (const vector of loadVectors()) {
      // Vectors with changes need the Daml unitsAt rule and error vectors the Daml rejection;
      // both are covered by the Daml tests.
      if (vector.changes || !vector.expected) continue;
      const actual = proRata(vector.total, vector.holdings);
      expect(actual.map((p) => p.holder).sort(), vector.name).toEqual(
        vector.expected.map((e) => e.holder).sort(),
      );
      for (const e of vector.expected) {
        const got = actual.find((p) => p.holder === e.holder);
        sameDecimal(got?.amount ?? '', e.amount);
      }
    }
  });

  let pendingInstructionCid = '';

  it('proposes with correct pro-rata payouts and executes; payments are visible to the agent', async () => {
    const { parties, ids, ledger } = world;
    const input = proposalInput(world, { cycleId: '2026-09', total: '5000' });
    sameDecimal(input.payouts[0]?.amount ?? '', '500');
    sameDecimal(input.payouts[1]?.amount ?? '', '1500');
    sameDecimal(input.payouts[2]?.amount ?? '', '3000');
    const proposeTx = await as.as(
      [parties.agent],
      [ledger.commands.mandatePropose(ids.mandateCid, input)],
      {
        readAs: [parties.treasury],
      },
    );
    const { proposalCid, mandateCid: afterPropose } = choiceResults.mandatePropose(proposeTx);
    // Proposing consumes the Mandate: the new one records the attempt.
    expect(afterPropose).not.toBe(ids.mandateCid);
    world.ids.mandateCid = afterPropose;

    const proposals = await ledger.reader.proposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.payload).toMatchObject({
      verdict: 'AutoExecute',
      cycleId: '2026-09',
      proposalId: 'proposal/2026-09/1',
      approvals: [],
      decisionRecordId: 'decision/2026-09/1',
    });
    const decisions = await ledger.reader.decisionRecords();
    expect(decisions[0]?.payload).toMatchObject({
      recordId: 'decision/2026-09/1',
      verdict: 'AutoExecute',
      trigger: 'TriggerSchedule',
      memoSource: 'template',
    });
    expect(decisions[0]?.payload.checks[0]).toMatchObject({
      code: 'cap',
      passed: true,
      blocking: true,
    });
    expect(decisions[0]?.payload.inputFingerprints).toEqual([
      { label: 'register', sha256: 'ab12' },
    ]);
    expect(decisions[0]?.payload.payouts.map((p) => p.units)).toEqual([100, 300, 600]);
    sameDecimal(decisions[0]?.payload.total ?? '', '5000');

    // The treasury's holdings are the inputs; A and B have a preapproval, C gets a pending transfer.
    const adapter = createTokenStandardAdapter({
      ledger: ledger.client,
      registryUrl: 'http://localhost:1/unused',
      instrument: { admin: parties.registryAdmin, id: 'CC' },
    });
    const holdings = await adapter.holdings(parties.treasury);
    const legs = input.payouts.map((p) =>
      testLeg(
        ids.factoryCid,
        p.holder,
        p.holder === parties.holderC ? undefined : ids.preapprovals[p.holder],
      ),
    );
    const executeTx = await as.as(
      [parties.agent],
      [
        ledger.commands.mandateAgentExecute(ids.mandateCid, {
          proposalCid,
          legs,
          inputHoldingCids: holdings.map((h) => h.contractId),
          executeBefore: new Date(Date.now() + 24 * 60 * 60 * 1000),
        }),
      ],
      { readAs: [parties.treasury] },
    );
    const { mandateCid } = choiceResults.mandateAgentExecute(executeTx);
    world.ids.mandateCid = mandateCid;

    const payments = await ledger.reader.payments();
    expect(payments).toHaveLength(3);
    const byHolder = new Map(payments.map((p) => [p.payload.holder, p.payload]));
    expect(byHolder.get(parties.holderA)).toMatchObject({
      status: 'Paid',
      units: 100,
      transferInstructionCid: null,
    });
    expect(byHolder.get(parties.holderC)).toMatchObject({
      status: 'AwaitingAcceptance',
      units: 600,
    });
    sameDecimal(byHolder.get(parties.holderA)?.amount ?? '', '500');
    sameDecimal(byHolder.get(parties.holderB)?.amount ?? '', '1500');
    sameDecimal(byHolder.get(parties.holderC)?.amount ?? '', '3000');
    pendingInstructionCid = byHolder.get(parties.holderC)?.transferInstructionCid ?? '';
    expect(pendingInstructionCid).not.toBe('');

    const outcomes = await ledger.reader.outcomes();
    expect(outcomes).toHaveLength(1);
    const outcome: DistributionOutcome | undefined = outcomes[0]?.payload;
    expect(outcome).toMatchObject({
      kind: 'Executed',
      recordId: 'outcome/2026-09/1',
      reason: null,
      actor: parties.agent,
    });
    expect(outcome?.payments.map((p) => p.status)).toEqual(['Paid', 'Paid', 'AwaitingAcceptance']);
    expect((await ledger.reader.mandate())?.payload.executedCycles).toEqual(['2026-09']);

    // Funds moved: holders A and B hold their payment, the treasury kept the change.
    sameDecimal(await adapter.balance(parties.holderA), '500');
    sameDecimal(await adapter.balance(parties.holderB), '1500');
    sameDecimal(await adapter.balance(parties.holderC), '0');
    sameDecimal(await adapter.balance(parties.treasury), '995000');
  });

  it("shows holder A only A's Payment and FundUnit when queried as holder A (L7)", async () => {
    const { parties, ledger } = world;
    const active = await ledger.client.activeContracts({ parties: [parties.holderA] });
    const mithra = active.filter(
      (c) => c.entity.startsWith('Mithra.') && !c.entity.startsWith('Mithra.Test.'),
    );
    expect(mithra.map((c) => c.entity).sort()).toEqual([
      'Mithra.Payment:Payment',
      'Mithra.Units:FundUnit',
    ]);

    const asA = ledger.reader.as([parties.holderA]);
    const payments = await asA.payments();
    expect(payments).toHaveLength(1);
    expect(payments[0]?.payload.holder).toBe(parties.holderA);
    expect((await asA.fundUnits()).map((u) => u.payload.holder)).toEqual([parties.holderA]);
    // The register, decision records and outcomes are not visible to a holder.
    expect(await asA.register()).toBeNull();
    expect(await asA.decisionRecords()).toEqual([]);
    expect(await asA.outcomes()).toEqual([]);
    expect(await asA.proposals()).toEqual([]);
  });

  it('lets a holder accept units, then the agent marks an accepted pending payment as paid', async () => {
    const { parties, ledger } = world;
    const [unit] = await ledger.reader.as([parties.holderA]).fundUnits(parties.holderA);
    const acceptTx = await as.as(
      [parties.holderA],
      [ledger.commands.fundUnitAccept(unit?.contractId ?? '')],
    );
    choiceResults.fundUnitAccept(acceptTx);
    expect((await ledger.reader.fundUnits(parties.holderA))[0]?.payload.accepted).toBe(true);

    // Holder C accepts the pending transfer in the registry (interface choice), then the agent records it.
    const acceptTransfer = await as.as(
      [parties.holderC],
      [
        {
          ExerciseCommand: {
            templateId: TRANSFER_INSTRUCTION_INTERFACE,
            contractId: pendingInstructionCid,
            choice: 'TransferInstruction_Accept',
            choiceArgument: { extraArgs: EMPTY_EXTRA_ARGS },
          },
        },
      ],
    );
    expect(createdIn(acceptTransfer, 'Mithra.Test.Registry:TestHolding')).toHaveLength(1);
    const payment = (await ledger.reader.payments()).find(
      (p) => p.payload.holder === parties.holderC,
    );
    const markTx = await as.as(
      [parties.agent],
      [ledger.commands.paymentMarkAccepted(payment?.contractId ?? '')],
      {
        readAs: [parties.treasury],
      },
    );
    choiceResults.paymentMarkAccepted(markTx);
    const paid = (await ledger.reader.payments()).find((p) => p.payload.holder === parties.holderC);
    expect(paid?.payload.status).toBe('Paid');
  });

  it('surfaces a Daml assertion as a LedgerError with the clean message', async () => {
    const { parties, ids, ledger } = world;
    const good = proposalInput(world, { cycleId: '2026-08', total: '6000' });
    const [first, ...rest] = good.payouts;
    const altered = { ...good, payouts: [{ ...first!, amount: '1' }, ...rest] };
    const error = await as
      .as([parties.agent], [ledger.commands.mandatePropose(ids.mandateCid, altered)], {
        readAs: [parties.treasury],
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(LedgerError);
    const ledgerError = error as LedgerError;
    expect(ledgerError.message).toBe(
      'Payees and amounts must equal the pro-rata split of the units held on the record date',
    );
    expect(ledgerError.code).toBe('DAML_FAILURE');
    expect(ledgerError.retryable).toBe(false);
    expect(ledgerError.status).toBe(400);

    // A cycle that was already executed is rejected with its label in the message.
    const again = proposalInput(world, { cycleId: '2026-09', total: '1000' });
    await expect(
      as.as([parties.agent], [ledger.commands.mandatePropose(ids.mandateCid, again)], {
        readAs: [parties.treasury],
      }),
    ).rejects.toMatchObject({
      message: 'A distribution for Cycle 2026-09 has already been executed',
    });
  });

  it('runs an over-cap proposal through approvals, cancel, a second attempt and reject', async () => {
    const { parties, ids, ledger } = world;
    const input = proposalInput(world, { cycleId: '2026-08', total: '6000' });
    const proposeTx = await as.as(
      [parties.agent],
      [ledger.commands.mandatePropose(ids.mandateCid, input)],
      {
        readAs: [parties.treasury],
      },
    );
    const { proposalCid, mandateCid } = choiceResults.mandatePropose(proposeTx);
    world.ids.mandateCid = mandateCid;
    expect(
      (await ledger.reader.proposals()).find((p) => p.contractId === proposalCid)?.payload.verdict,
    ).toBe('NeedsApproval');

    // One approval is not enough for the threshold of two.
    const approveTx = await as.as(
      [parties.approver1],
      [
        ledger.commands.proposalApprove(proposalCid, {
          approver: parties.approver1,
          note: 'Looks right',
        }),
      ],
    );
    const approved = choiceResults.proposalApprove(approveTx);
    const execute = (cid: string) =>
      ledger.commands.mandateAgentExecute(ids.mandateCid, {
        proposalCid: cid,
        legs: input.payouts.map((p) =>
          testLeg(ids.factoryCid, p.holder, ids.preapprovals[p.holder]),
        ),
        inputHoldingCids: [],
        executeBefore: new Date(Date.now() + 60_000),
      });
    await expect(
      as.as([parties.agent], [execute(approved.proposalCid)], { readAs: [parties.treasury] }),
    ).rejects.toMatchObject({
      message: "This distribution needs 2 approval(s) from the Mandate's approvers and has 1",
    });
    const approvals = await ledger.reader.approvals();
    expect(approvals.map((a) => [a.payload.approver, a.payload.note])).toEqual([
      [parties.approver1, 'Looks right'],
    ]);
    // The same approver cannot approve twice (L5).
    await expect(
      as.as(
        [parties.approver1],
        [
          ledger.commands.proposalApprove(approved.proposalCid, {
            approver: parties.approver1,
            note: 'again',
          }),
        ],
      ),
    ).rejects.toMatchObject({ message: 'This approver has already approved this proposal' });

    // The treasurer cancels (L11); the cycle can then be proposed again as attempt 2.
    const cancelTx = await as.as(
      [parties.treasurer],
      [ledger.commands.proposalCancel(approved.proposalCid)],
    );
    choiceResults.proposalCancel(cancelTx);
    const cancelled = (await ledger.reader.outcomes()).find((o) => o.payload.kind === 'Cancelled');
    expect(cancelled?.payload).toMatchObject({
      recordId: 'outcome/2026-08/1',
      reason: null,
      actor: parties.treasurer,
    });
    expect(cancelled?.payload.approvals).toHaveLength(1);

    const second = proposalInput(world, { cycleId: '2026-08', total: '6000', attempt: 2 });
    const secondTx = await as.as(
      [parties.agent],
      [ledger.commands.mandatePropose(ids.mandateCid, second)],
      {
        readAs: [parties.treasury],
      },
    );
    const secondResult = choiceResults.mandatePropose(secondTx);
    world.ids.mandateCid = secondResult.mandateCid;
    const rejectTx = await as.as(
      [parties.approver2],
      [
        ledger.commands.proposalReject(secondResult.proposalCid, {
          approver: parties.approver2,
          reason: 'Too much for this month',
        }),
      ],
    );
    choiceResults.proposalReject(rejectTx);
    const rejected = (await ledger.reader.outcomes()).find((o) => o.payload.kind === 'Rejected');
    expect(rejected?.payload).toMatchObject({
      recordId: 'outcome/2026-08/2',
      reason: 'Too much for this month',
      actor: parties.approver2,
    });
    expect(await ledger.reader.proposals()).toEqual([]);

    // The ledger numbers the attempts: attempt 2 is taken, so the next one is 3.
    const propose = (input: ProposalInput) =>
      as.as([parties.agent], [ledger.commands.mandatePropose(ids.mandateCid, input)], {
        readAs: [parties.treasury],
      });
    await expect(propose(second)).rejects.toMatchObject({
      message: expect.stringContaining('Attempt 2 for cycle 2026-08 is not the next one') as string,
    });
    await expect(propose({ ...second, attempt: 4 })).rejects.toMatchObject({
      message: expect.stringContaining('must be 3') as string,
    });
    // The cycle id and the record date are checked by the ledger, whatever the agent sends.
    const third = proposalInput(world, { cycleId: '2026-08', total: '6000', attempt: 3 });
    await expect(propose({ ...third, cycleId: '2026-08-b' })).rejects.toMatchObject({
      message: expect.stringContaining('The cycle id must be YYYY-MM') as string,
    });
    await expect(propose({ ...third, recordDate: '2026-08-30' })).rejects.toMatchObject({
      message: expect.stringContaining('last day of 2026-08') as string,
    });
    const future = proposalInput(world, { cycleId: '2099-12', total: '6000' });
    await expect(propose(future)).rejects.toMatchObject({
      message: expect.stringContaining('has not happened yet') as string,
    });
    // Attempt 3 goes through and the Mandate moves on again.
    const thirdResult = choiceResults.mandatePropose(await propose(third));
    world.ids.mandateCid = thirdResult.mandateCid;
    expect(
      (await ledger.reader.decisionRecords())
        .filter((d) => d.payload.cycleId === '2026-08')
        .map((d) => d.payload.recordId)
        .sort(),
    ).toEqual(['decision/2026-08/1', 'decision/2026-08/2', 'decision/2026-08/3']);
    expect(
      (await ledger.reader.mandate())?.payload.cycleAttempts.find((a) => a.cycleId === '2026-08')
        ?.attempt,
    ).toBe(3);
    // Left pending, a cycle nobody uses again: cancel it so the next test starts clean.
    choiceResults.proposalCancel(
      await as.as([parties.treasurer], [ledger.commands.proposalCancel(thirdResult.proposalCid)]),
    );
  });

  it('lets the treasury execute a payout itself (MainNet path) and record who acted', async () => {
    const { parties, ids, ledger } = world;
    const input = proposalInput(world, { cycleId: '2026-07', total: '1000' });
    const proposeTx = await as.as(
      [parties.agent],
      [ledger.commands.mandatePropose(ids.mandateCid, input)],
      {
        readAs: [parties.treasury],
      },
    );
    const { proposalCid, mandateCid: proposedOn } = choiceResults.mandatePropose(proposeTx);
    world.ids.mandateCid = proposedOn;
    const adapter = createTokenStandardAdapter({
      ledger: ledger.client,
      registryUrl: 'http://localhost:1/unused',
      instrument: { admin: parties.registryAdmin, id: 'CC' },
    });
    const holdings = await adapter.holdings(parties.treasury);
    const tx = await as.as(
      [parties.treasury],
      [
        ledger.commands.mandateTreasuryExecute(ids.mandateCid, {
          proposalCid,
          legs: input.payouts.map((p) =>
            testLeg(ids.factoryCid, p.holder, ids.preapprovals[p.holder]),
          ),
          inputHoldingCids: holdings.map((h) => h.contractId),
          executeBefore: new Date(Date.now() + 60_000),
        }),
      ],
      { readAs: [parties.agent] },
    );
    const { mandateCid, outcomeCid } = choiceResults.mandateTreasuryExecute(tx);
    world.ids.mandateCid = mandateCid;
    const outcome = (await ledger.reader.outcomes()).find((o) => o.contractId === outcomeCid);
    expect(outcome?.payload).toMatchObject({ kind: 'Executed', actor: parties.treasury });
    expect((await ledger.reader.mandate())?.payload.executedCycles).toEqual(['2026-09', '2026-07']);
  });

  it('encodes variants and tuples: Org_GrantAccess with RefDecision and RefOutcome evidence', async () => {
    const { parties, ids, ledger } = world;
    const decision = (await ledger.reader.decisionRecords()).find(
      (d) => d.payload.cycleId === '2026-09',
    );
    const outcome = (await ledger.reader.outcomes()).find(
      (o) => o.payload.kind === 'Executed' && o.payload.cycleId === '2026-09',
    );
    expect(decision && outcome).toBeTruthy();
    const requestTx = await as.as(
      [parties.auditor],
      [
        ledger.commands.createAuditRequest({
          auditor: parties.auditor,
          treasury: parties.treasury,
          treasurer: parties.treasurer,
          agent: parties.agent,
          requestId: 'req-1',
          question: 'Why was September paid out the way it was?',
          scope: [
            {
              recordId: decision?.payload.recordId ?? '',
              kind: 'decision',
              reason: 'Why the total',
            },
            { recordId: outcome?.payload.recordId ?? '', kind: 'outcome', reason: 'What was paid' },
          ],
          excluded: 'Holder identities',
          requestedAt: new Date(),
        }),
      ],
    );
    const requestCid = createdIn(requestTx, 'Mithra.Audit:AuditRequest')[0]?.contractId ?? '';
    expect((await ledger.reader.auditRequests())[0]?.payload).toMatchObject({
      requestId: 'req-1',
      auditor: parties.auditor,
    });

    // Before a grant the auditor sees no decision record, outcome or shared record (L8).
    const asAuditor = ledger.reader.as([parties.auditor]);
    expect(await asAuditor.decisionRecords()).toEqual([]);
    expect(await asAuditor.outcomes()).toEqual([]);
    expect(await asAuditor.sharedRecords(parties.auditor)).toEqual([]);

    const expiresAt = new Date(Date.now() + 4000);
    const grantTx: Transaction = await as.as(
      [parties.treasurer],
      [
        ledger.commands.orgGrantAccess(ids.orgCid, {
          requestCid,
          expiresAt,
          evidence: [
            { tag: 'RefDecision', value: decision?.contractId ?? '' },
            { tag: 'RefOutcome', value: outcome?.contractId ?? '' },
          ],
        }),
      ],
      { readAs: [parties.agent] },
    );
    const { grantCid } = choiceResults.orgGrantAccess(grantTx);
    expect(grantCid).toMatch(/^[0-9a-f]+$/);

    const shared = await asAuditor.sharedRecords(parties.auditor);
    expect(shared.map((s) => s.payload.evidence.tag).sort()).toEqual(['EvDecision', 'EvOutcome']);
    const evDecision = shared.find((s) => s.payload.evidence.tag === 'EvDecision')?.payload
      .evidence;
    expect(evDecision?.tag === 'EvDecision' && evDecision.value.recordId).toBe(
      'decision/2026-09/1',
    );
    expect(evDecision?.tag === 'EvDecision' && evDecision.value.payouts).toHaveLength(3);
    // The auditor still sees no decision record contract itself, only the shared copies.
    expect(await asAuditor.decisionRecords()).toEqual([]);
    const grants = await ledger.reader.grants();
    expect(grants[0]?.payload).toMatchObject({ requestId: 'req-1', grantId: 'grant/req-1' });
    expect(grants[0]?.payload.recordIds).toHaveLength(2);
    expect(grants[0]?.payload.sharedCids).toHaveLength(2);

    // After expiry the agent closes the grant and the auditor sees nothing more (L9).
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const closeTx = await as.as(
      [parties.agent],
      [
        ledger.commands.accessGrantCloseExpired(grants[0]?.contractId ?? '', {
          closer: parties.agent,
        }),
      ],
      { readAs: [parties.treasury] },
    );
    choiceResults.accessGrantCloseExpired(closeTx);
    expect(await asAuditor.sharedRecords(parties.auditor)).toEqual([]);
    expect(await ledger.reader.grants()).toEqual([]);
    const closed = await ledger.reader.closed();
    expect(closed[0]?.payload).toMatchObject({
      reason: 'expired',
      closedBy: parties.agent,
      grantId: 'grant/req-1',
    });
  });

  it('denies and revokes access, withdraws requests, and creates governed actions', async () => {
    const { parties, ids, ledger } = world;
    const decision = (await ledger.reader.decisionRecords())[0];
    const scope = [
      { recordId: decision?.payload.recordId ?? '', kind: 'decision', reason: 'check' },
    ];
    const request = async (requestId: string): Promise<string> => {
      const tx = await as.as(
        [parties.auditor],
        [
          ledger.commands.createAuditRequest({
            auditor: parties.auditor,
            treasury: parties.treasury,
            treasurer: parties.treasurer,
            agent: parties.agent,
            requestId,
            question: 'Question',
            scope,
            excluded: '',
            requestedAt: new Date(),
          }),
        ],
      );
      return createdIn(tx, 'Mithra.Audit:AuditRequest')[0]?.contractId ?? '';
    };

    // Denied.
    const denyCid = await request('req-deny');
    choiceResults.orgDenyAccess(
      await as.as(
        [parties.treasurer],
        [
          ledger.commands.orgDenyAccess(ids.orgCid, {
            requestCid: denyCid,
            reason: 'Out of scope',
          }),
        ],
        {
          readAs: [parties.agent],
        },
      ),
    );
    expect((await ledger.reader.denied())[0]?.payload).toMatchObject({
      requestId: 'req-deny',
      reason: 'Out of scope',
    });

    // Granted, then revoked by the treasurer at any time.
    const grantReq = await request('req-revoke');
    const grantTx = await as.as(
      [parties.treasurer],
      [
        ledger.commands.orgGrantAccess(ids.orgCid, {
          requestCid: grantReq,
          expiresAt: new Date(Date.now() + 3_600_000),
          evidence: [{ tag: 'RefDecision', value: decision?.contractId ?? '' }],
        }),
      ],
      { readAs: [parties.agent] },
    );
    const { grantCid } = choiceResults.orgGrantAccess(grantTx);
    const revokeTx = await as.as(
      [parties.treasurer],
      [ledger.commands.accessGrantRevoke(grantCid)],
      { readAs: [parties.agent] },
    );
    choiceResults.accessGrantRevoke(revokeTx);
    expect((await ledger.reader.closed()).map((c) => c.payload.reason).sort()).toEqual([
      'expired',
      'revoked',
    ]);

    // Withdrawn audit request.
    const withdrawCid = await request('req-withdraw');
    await as.as([parties.auditor], [ledger.commands.auditRequestWithdraw(withdrawCid)]);
    expect((await ledger.reader.auditRequests()).map((r) => r.payload.requestId)).not.toContain(
      'req-withdraw',
    );

    // Withdrawn seal request.
    const sealTx = await as.as(
      [parties.treasurer],
      [
        ledger.commands.createMandateSealRequest({
          treasury: parties.treasury,
          treasurer: parties.treasurer,
          agent: parties.agent,
          terms: { ...world.terms, cap: '1234.5' },
          agentExecutes: false,
          summary: 'Lower cap',
          summaryFingerprint: 'ff',
          requestedAt: new Date(),
        }),
      ],
    );
    const sealCid = createdIn(sealTx, 'Mithra.Mandate:MandateSealRequest')[0]?.contractId ?? '';
    expect((await ledger.reader.sealRequests())[0]?.payload).toMatchObject({
      summary: 'Lower cap',
      agentExecutes: false,
    });
    sameDecimal((await ledger.reader.sealRequests())[0]?.payload.terms.cap ?? '', '1234.5');
    await as.as([parties.treasurer], [ledger.commands.sealRequestWithdraw(sealCid)]);
    expect(await ledger.reader.sealRequests()).toEqual([]);

    // Governed actions (LocalNet), created by the operator; Optional None encodes as null.
    const charterProposalTx = await as.as(
      [parties.operator],
      [
        ledger.commands.createCharterProposal({
          governanceParty: parties.treasury,
          proposer: parties.operator,
          treasurer: parties.treasurer,
          agent: parties.agent,
          operator: parties.operator,
        }),
      ],
    );
    expect(createdIn(charterProposalTx, 'Mithra.Governance:CharterProposal')).toHaveLength(1);
    const changeTx = await as.as(
      [parties.operator],
      [
        ledger.commands.createMandateChangeProposal({
          governanceParty: parties.treasury,
          proposer: parties.operator,
          orgCid: ids.orgCid,
          sealRequestCid: sealCid,
          currentMandateCid: null,
          description: 'Lower the cap',
        }),
      ],
    );
    const changeEvent = createdIn(changeTx, 'Mithra.Governance:MandateChangeProposal')[0];
    expect(changeEvent?.createArgument).toMatchObject({
      currentMandateCid: null,
      description: 'Lower the cap',
    });
  });

  it('reads a transaction back by update id', async () => {
    const { parties, ledger } = world;
    const tx = await as.as(
      [parties.operator],
      [
        ledger.commands.createCharterProposal({
          governanceParty: parties.treasury,
          proposer: parties.operator,
          treasurer: parties.treasurer,
          agent: parties.agent,
          operator: parties.operator,
        }),
      ],
    );
    const again = await ledger.client.updateById(tx.updateId, [parties.operator]);
    expect(again.updateId).toBe(tx.updateId);
    expect(createdIn(again, 'Mithra.Governance:CharterProposal')).toHaveLength(1);
  });

  it('does not retry a submission the ledger answered definitively', async () => {
    let calls = 0;
    const counting: typeof fetch = (input, init) => {
      calls += 1;
      return fetch(input, init);
    };
    const ledger = createLedger(world.config, { fetch: counting });
    await expect(
      ledger.client.submit({
        actAs: [world.parties.agent],
        readAs: [world.parties.treasury],
        commands: [
          ledger.commands.mandatePropose(
            world.ids.mandateCid,
            proposalInput(world, { cycleId: '2026-07', total: '1000' }),
          ),
        ],
      }),
    ).rejects.toBeInstanceOf(LedgerError);
    expect(calls).toBe(1);
  });
});
