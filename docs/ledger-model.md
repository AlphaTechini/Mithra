# Mithra ledger model

The Daml model that makes the product's guarantees ledger rules (specs.md Section 1, L1 to L11). Package `mithra-v1` in `daml/mithra`; tests in `daml/mithra-tests`. Research behind it: `docs/research/daml.md`, `docs/research/bitsafe-dm.md`.

## Parties

| Party | LocalNet | MainNet |
|---|---|---|
| `treasury` | BitSafe Decentralized Party hosted on 3 nodes, threshold 2. Cannot submit; its authority comes from governed actions and delegation | the treasurer's own Grofty party (`treasury == treasurer`) |
| `treasurer` | local party on node A, signed server-side | Grofty party |
| `agent` | local party on node A, used only by the backend | operator-hosted party from env |
| `operator` | local party on node A (DecMan additional proposer) | operator-hosted party from env |
| approvers | local parties on node A | Grofty parties |
| holders | local parties on node B | Grofty parties |
| auditor | local party on node C | Grofty party |

Every user action is a **single-party** submission (Grofty refuses multi-party `actAs`).

## Authority flow

```
GovernanceRules (DecMan, signed by treasury)
  └─ CharterProposal.executeImpl ──creates──> TreasuryCharter (sig: treasury)
                                                └─ Charter_CreateOrganization (ctl: treasurer)
                                                     ├─ Organization (sig: treasury, treasurer)
                                                     └─ UnitRegister (sig: treasury)
treasurer creates MandateSealRequest (sig: treasurer)
GovernanceRules
  └─ MandateChangeProposal.executeImpl ──> Org_ApplySeal (ctl: treasury)
                                             ├─ consumes MandateSealRequest
                                             ├─ supersedes the old Mandate
                                             └─ Mandate (sig: treasury, treasurer)
Mandate_Propose (ctl: agent)        ──> DecisionRecord + Proposal (sig: treasury, agent)
Proposal_Approve (ctl: approver)    ──> Proposal.approvals += approver, Approval (sig: approver)
Mandate_AgentExecute (ctl: agent)   ──> TransferFactory_Transfer (sender: treasury) per payee,
                                         Payment per payee, DistributionOutcome
```
On MainNet, `treasury == treasurer`, so the treasurer creates the `TreasuryCharter` and exercises `Org_ApplySeal` directly, and payouts are executed by the treasurer with `Mandate_TreasuryExecute` (signed in Grofty). Same templates, same choices.

## Data types (`Mithra.Types`)

```daml
data Verdict = AutoExecute | NeedsApproval deriving (Eq, Show)
data Trigger = TriggerSchedule | TriggerPrompt | TriggerManual deriving (Eq, Show)
data Fingerprint = Fingerprint with label : Text; sha256 : Text deriving (Eq, Show)
data CheckResult = CheckResult with
    code : Text        -- "cap", "balance", "non_holder", "duplicate_cycle", "deviation", "unit_spike", "prompt_amount", "ai_advisory"
    label : Text
    passed : Bool
    blocking : Bool    -- a failed blocking check forces NeedsApproval
    actual : Text      -- shown to people, e.g. "1,200 CC vs 3-cycle average 410 CC, +193%"
    limit : Text
    source : Text      -- "deterministic" | "ai"
  deriving (Eq, Show)
data Payout = Payout with holder : Party; units : Int; amount : Decimal deriving (Eq, Show)
data UnitChange = UnitChange with
    holder : Party; delta : Int; effectiveDate : Date; recordedAt : Time; seeded : Bool
  deriving (Eq, Show)
data MandateTerms = MandateTerms with
    cap : Decimal                -- auto-execute cap
    approvers : [Party]
    approvalThreshold : Int
    asset : InstrumentId         -- CC on the configured network; USDCx later without redesign
    scheduleCron : Text          -- e.g. "0 9 1 * *"
    scheduleTimezone : Text      -- "UTC"
    recordDateRule : Text        -- "last_day_of_previous_month"
    fixedAmount : Optional Decimal
    deviationPct : Decimal       -- flag if total deviates more than this % from trailing average
    trailingCycles : Int
    unitChangePct : Decimal      -- flag if a holder's units changed more than this % ...
    unitChangeWindowDays : Int   -- ... in this many days before the record date
    feeBuffer : Decimal
  deriving (Eq, Show)
data ApprovalEntry = ApprovalEntry with approver : Party; at : Time; note : Text deriving (Eq, Show)
data PaymentStatus = Paid | AwaitingAcceptance deriving (Eq, Show)
data PaymentRef = PaymentRef with
    holder : Party; amount : Decimal; paymentCid : ContractId Payment; status : PaymentStatus
    transferInstructionCid : Optional (ContractId TransferInstruction)
  deriving (Eq, Show)
data TransferLeg = TransferLeg with
    holder : Party; factoryCid : ContractId TransferFactory; extraArgs : ExtraArgs
  deriving (Eq, Show)
data ScopeItem = ScopeItem with recordId : Text; kind : Text; reason : Text deriving (Eq, Show)
```

## Pro-rata rule (documented rounding rule, L2)

`unitsAt recordDate changes` = for each holder, the sum of `delta` over changes with `effectiveDate <= recordDate`; holders with a positive sum only.

`computeProRata total holdings`:
1. Sort holders by `partyToText` ascending.
2. `T` = total units. For each holder, `share = floor10(total * units / T)` where `floor10` rounds **down** to 10 decimal places (Daml `Decimal` scale).
3. `residual = total - sum shares` (always `0 <= residual < n * 0.0000000001`). Add the residual to the holder with the most units; ties go to the first holder in sort order.
4. Result: `[Payout holder units amount]` in sorted order. `sum amounts == total` exactly.

Daml implementation of `floor10 n d` (n, d Decimal, d > 0): `q = n / d`; if `q * d > n` then `q - 0.0000000001` else `q`. This is correct whatever rounding mode Daml's division uses. The backend implements the same rule with `decimal.js` (`ROUND_DOWN`, 10 places) and a shared test vector file keeps both sides in step (`packages/shared/test-vectors/prorata.json`).

## Templates

### `TreasuryCharter` (`Mithra.Charter`)
`signatory treasury; observer treasurer, agent, operator`. Fields: `treasury, treasurer, agent, operator : Party`.
- `Charter_CreateOrganization` (consuming) `controller treasurer` with `name : Text, asset : InstrumentId, approvers : [Party], approvalThreshold : Int` → creates `Organization` and an empty `UnitRegister`. Consuming, so an organization can be created once.

### `Organization` (`Mithra.Org`)
`signatory treasury, treasurer; observer agent, operator, approvers`. Fields: `treasury, treasurer, agent, operator, name, asset, approvers, approvalThreshold, mandateVersion : Int` (0 before the first seal). `ensure` unique approvers, `1 <= threshold <= length approvers`, `agent notElem approvers`.
- `Org_IssueUnits` (nonconsuming) `controller treasurer` with `registerCid, holder, units : Int (> 0), effectiveDate : Date (<= today), seeded : Bool` → `Register_Record` + creates `FundUnit` (not yet accepted). Returns `(ContractId UnitRegister, ContractId FundUnit)`.
- `Org_ApplySeal` (consuming) `controller treasury` with `sealRequestCid, currentMandateCid : Optional (ContractId Mandate)` → consumes the treasurer-signed `MandateSealRequest` (must match this org's treasury/treasurer), requires `currentMandateCid` to be `None` iff `mandateVersion == 0`, supersedes the current mandate (carrying `executedCycles`), recreates the `Organization` with the request's approvers/threshold and `mandateVersion + 1`, creates the new `Mandate`. Returns `(ContractId Organization, ContractId Mandate)`.
- `Org_GrantAccess` (nonconsuming) `controller treasurer` with `requestCid, expiresAt : Time (> now), evidence : [EvidenceRef]` → resolves the request, fetches each referenced record, checks each record's `recordId` is in the request scope, creates one `SharedRecord` per record and an `AccessGrant`. Returns the grant cid.
- `Org_DenyAccess` (nonconsuming) `controller treasurer` with `requestCid, reason : Text` → resolves the request, creates `AccessDenied`.

### `UnitRegister` (`Mithra.Units`)
`signatory treasury; observer treasurer, agent`. Fields: `treasury, treasurer, agent, changes : [UnitChange]`. Holders are never stakeholders (L7).
- `Register_Record` (consuming) `controller treasury` with `change : UnitChange` → recreated with the change appended.

### `FundUnit` (`Mithra.Units`)
`signatory treasury; observer holder`. Fields: `treasury, holder, orgName, units, effectiveDate, issuedAt, accepted : Bool, seeded`.
- `FundUnit_Accept` (consuming) `controller holder` → recreated with `accepted = True`.

### `MandateSealRequest` (`Mithra.Mandate`)
`signatory treasurer; observer treasury, agent`. Fields: `treasury, treasurer, agent, terms : MandateTerms, agentExecutes : Bool, summary : Text, summaryFingerprint : Text, requestedAt : Time`. `ensure` terms are valid (cap >= 0, unique approvers, threshold range, agent not an approver).
- `SealRequest_Consume` `controller treasury` → returns `this`.
- `SealRequest_Withdraw` `controller treasurer`.

### `Mandate` (`Mithra.Mandate`)
`signatory treasury, treasurer; observer agent, terms.approvers`. Fields: `treasury, treasurer, agent, version : Int, terms : MandateTerms, agentExecutes : Bool, executedCycles : [Text], sealedAt : Time, summaryFingerprint : Text`.
- `Mandate_Propose` (nonconsuming) `controller agent` with `ProposalInput { cycleId, cycleLabel, total, recordDate, trigger, triggerDetail, payouts, registerCid, inputFingerprints, checks, memo, memoSource, modelFingerprints, seeded }`:
  - `cycleId notElem executedCycles` (L3, early),
  - fetch the register; `payouts == computeProRata total (unitsAt recordDate register.changes)` and non-empty (L2),
  - `total > 0`,
  - verdict is computed **here**: `NeedsApproval` if `total > terms.cap` or any check has `blocking && not passed`, else `AutoExecute` (A5, A6: the agent cannot pick the verdict, and an AI flag can add a failed check but the deterministic ones are supplied and kept as given),
  - creates `DecisionRecord` and `Proposal`. Returns `(ContractId Proposal, ContractId DecisionRecord)`.
- `Mandate_AgentExecute` (consuming, recreated with `cycleId` added to `executedCycles`) `controller agent` with `proposalCid, legs : [TransferLeg], inputHoldingCids : [ContractId Holding], executeBefore : Time`; requires `agentExecutes`. Returns `(ContractId Mandate, ContractId DistributionOutcome)`.
- `Mandate_TreasuryExecute` — same arguments and body, `controller treasury`, for MainNet where the treasurer signs the payout.
- Shared execution body:
  - proposal belongs to this treasury; `cycleId notElem executedCycles` (L3),
  - `AutoExecute` proposals: `total <= terms.cap` against the **current** terms (L1),
  - `NeedsApproval` proposals: distinct approvers in `proposal.approvals` that are in current `terms.approvers` must number `>= terms.approvalThreshold` (L4),
  - `legs` line up one-to-one with `proposal.payouts` (same holder, same order),
  - for each payout: `exercise leg.factoryCid TransferFactory_Transfer with expectedAdmin = terms.asset.admin, transfer = Transfer { sender = treasury, receiver = holder, amount, instrumentId = terms.asset, requestedAt = now, executeBefore, inputHoldingCids = current, meta }, extraArgs = leg.extraArgs`; the next transfer's inputs are this result's `senderChangeCids`; `Completed` → `Paid`, `Pending` → `AwaitingAcceptance` with the instruction cid, `Failed` → abort,
  - creates one `Payment` per payee and a `DistributionOutcome` (kind `Executed`), archives the proposal (`Proposal_MarkExecuted`).
- `Mandate_Supersede` `controller treasury` → returns `executedCycles`.
- No choice lets the agent change terms (L6).

### `Proposal` (`Mithra.Proposal`)
`signatory treasury, agent; observer treasurer, approvers`. Fields: `treasury, treasurer, agent, proposalId : Text, cycleId, cycleLabel, recordDate, total, payouts, verdict, approvers, approvalThreshold, approvals : [ApprovalEntry], decisionRecordCid, decisionRecordId : Text, mandateVersion, createdAt, seeded`.
- `Proposal_Approve` (consuming, recreated) `controller approver` with `approver, note`: approver in `approvers`, not already in `approvals` (L5), verdict is `NeedsApproval`; also creates an `Approval` (sig: approver). Returns `(ContractId Proposal, ContractId Approval)`.
- `Proposal_Reject` (consuming) `controller approver` with `approver, reason` (non-empty) → `DistributionOutcome` kind `Rejected`.
- `Proposal_Cancel` (consuming) `controller treasurer` → `DistributionOutcome` kind `Cancelled` (L11).
- `Proposal_MarkExecuted` (consuming) `controller treasury` → returns `this`.

### `Approval` (`Mithra.Proposal`)
`signatory approver; observer treasury, treasurer, agent`. Fields: `approver, treasury, treasurer, agent, proposalId, cycleId, decisionRecordId, at, note`. The approver's signed decision.

### `DecisionRecord` (`Mithra.Decision`)
`signatory treasury, agent; observer treasurer, approvers`. Immutable. Fields: `recordId` (`"decision/<cycleId>/<n>"`), `treasury, agent, cycleId, cycleLabel, trigger, triggerDetail, recordDate, total, payouts, inputFingerprints, checks, memo, memoSource, modelFingerprints, verdict, mandateVersion, cap, createdAt, seeded`. Created only inside `Mandate_Propose` (L10 by construction: a `Proposal` can only come from `Mandate_Propose`, and execution needs a `Proposal`).

### `DistributionOutcome` (`Mithra.Decision`)
`signatory treasury, agent; observer treasurer, approvers`. Fields: `recordId` (`"outcome/<cycleId>/<n>"`), `decisionRecordId, cycleId, cycleLabel, kind : OutcomeKind, approvals, payments : [PaymentRef], actor : Party, reason : Optional Text, at : Time, seeded`. `OutcomeKind = Executed | Rejected | Cancelled`. Together with the `DecisionRecord` this gives L10's "approvals and payment references".

### `Payment` (`Mithra.Payment`)
`signatory treasury, agent; observer holder`. Fields: `treasury, agent, holder, cycleId, cycleLabel, units, amount, status, transferInstructionCid, executedAt, seeded`. A holder sees only their own (L7).
- `Payment_MarkAccepted` `controller agent` → recreated `Paid` (after the holder accepted a pending transfer).

### Audit (`Mithra.Audit`)
- `AuditRequest`: `signatory auditor; observer treasurer, agent`. Fields: `auditor, treasury, treasurer, agent, requestId, question, scope : [ScopeItem], excluded : Text, requestedAt`. `AuditRequest_Withdraw` (`controller auditor`), `AuditRequest_Resolve` (`controller treasurer`, returns `this`).
- `EvidenceRef = RefDecision (ContractId DecisionRecord) | RefOutcome (ContractId DistributionOutcome)`; `Evidence = EvDecision DecisionRecord | EvOutcome DistributionOutcome`.
- `SharedRecord`: `signatory treasury; observer auditor`. Fields: `treasury, auditor, grantId, recordId, evidence : Evidence, sharedAt, expiresAt`. `SharedRecord_Revoke` `controller treasury`.
- `AccessGrant`: `signatory treasury, treasurer; observer auditor, agent`. Fields: `treasury, treasurer, agent, auditor, grantId, requestId, question, recordIds, sharedCids, grantedAt, expiresAt`.
  - `AccessGrant_CloseExpired` `controller closer` with `closer`: closer is the agent, treasurer or auditor; `now >= expiresAt` (L9); revokes every shared record; creates `AccessClosed`.
  - `AccessGrant_Revoke` `controller treasurer` any time; same effect with reason `"revoked"`.
- `AccessClosed`: `signatory treasury, treasurer; observer auditor, agent`. Fields: `grantId, requestId, closedAt, closedBy, reason`.
- `AccessDenied`: `signatory treasury, treasurer; observer auditor, agent`. Fields: `requestId, reason, at`.

Auditor visibility (L8): the auditor is a stakeholder only of `AuditRequest`, `SharedRecord`, `AccessGrant`, `AccessClosed`, `AccessDenied`. Before a grant, queries for `DecisionRecord`, `DistributionOutcome`, `SharedRecord` return nothing; after, exactly one `SharedRecord` per listed record; after close, nothing. (Archived contracts remain in the auditor participant's transaction history; the app and the active contract set no longer show them. Stated in README.)

### Governed actions (`Mithra.Governance`, LocalNet)
Both implement `Governance.Action.GovernableAction` (BitSafe `governance-action-v1`): `signatory proposer; observer governanceParty`.
- `CharterProposal { governanceParty, proposer, treasurer, agent, operator }`, label `"MithraCreateCharter"`, `executeImpl` creates `TreasuryCharter`.
- `MandateChangeProposal { governanceParty, proposer, orgCid, sealRequestCid, currentMandateCid, description }`, label `"MithraSealMandate"`, `executeImpl` exercises `Org_ApplySeal`. Needs both the treasurer's signed request (L6) and the governance threshold of node confirmations (N8).

## What is enforced where

| Rule | Ledger (this model) | Backend |
|---|---|---|
| L1 cap | `Mandate_AgentExecute` checks current cap for auto proposals | shows countdown, Hold |
| L2 payees and amounts | `Mandate_Propose` recomputes pro-rata from the register | computes the same with decimal.js |
| L3 one per cycle | `executedCycles` on the single active Mandate | scheduler records runs |
| L4 threshold | execution counts proposal approvals against current terms | — |
| L5 one approval each, members only | `Proposal_Approve` | — |
| L6 treasurer signs changes | `Mandate` signed by treasurer; only `Org_ApplySeal` creates it, from a treasurer-signed request | — |
| L7 holder isolation | per-holder `FundUnit` and `Payment`; register and records not visible to holders | API scoping |
| L8, L9 audit | `SharedRecord` per grant, closed after expiry | expiry job within 5 minutes (A9) |
| L10 decision record | created in the same choice as the proposal | fingerprints prompts and responses |
| L11 cancel | `Proposal_Cancel` | — |
| Deviation, unit spike, balance, prompt amount | recorded as checks; a failed blocking check forces approval | computed deterministically |
