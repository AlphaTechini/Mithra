# Mithra: product details

This file describes what Mithra is, who uses it, what it does, and what it must never do. It is the source of truth for product decisions. It does not prescribe implementation. Technical constraints live in `specs.md`; screens and interactions live in `userflow.md`.

## 1. One-line summary

Mithra is a treasury app on Canton where an AI agent runs a fund's recurring yield distributions on schedule, inside spending limits the ledger enforces, and gives auditors scoped, time-limited, logged access to exactly the records they ask for.

## 2. Context

- **Event:** HackCanton Season 3 (organized by Noders on AppsFactory). Track 3: Investment Infrastructure (Funds, DAOs and Governance Tools).
- **Sponsor challenges entered:** Grofty Wallet bounty (wallet in the core flow, demo on Canton MainNet). BitSafe challenge (decentralized hosting of a party, reproducible LocalNet demo).
- **Builder:** solo.
- **Submission deadline:** October 9, 2026, 23:59 UTC.
- **Judging criteria (whole hackathon):** Value, ICP, Metrics, GTM, MVP, Pitch. Track 3 asks for role-based workflows (managers, investors) and a demonstration of transparency, auditability and operational logic.
- **Name:** Mithra, the ancient Persian deity of covenants, oaths, contracts and truth. The product keeps agreements on schedule and brings their truth to light for those entitled to inspect them.

## 3. The problem (from the Value doc, all figures verified)

- Nearly 9 in 10 US companies (88%) report payment operations problems, and 98% still perform some payment work manually (Modern Treasury, 2025).
- The median organization sends 1.5% of disbursements as duplicates or errors (APQC, 1,686 organizations).
- Manual review does not prevent large errors: in 2020 Citibank, acting as loan agent, meant to send a $7.8M Revlon interest payment and paid off the full $894M loan after three people reviewed it.
- 94% of finance leaders are excited about AI-assisted workflows (Modern Treasury, 2025), but fewer than 10% of large corporates have built AI into daily treasury work (Coalition Greenwich, 2025), and treasurers rate their AI policies 2.9 out of 5 (AFP, 2026). The missing piece is guardrails.
- Audit evidence is slow and lopsided: a single bank confirmation takes 10 to 25 business days (Chase, NatWest). On Canton, an auditor added as an observer "sees everything"; Canton's docs tell builders to "use workflow patterns to grant temporary audit access" but do not ship one.

## 4. Target user (from the ICP doc)

Institutions already on Canton that owe recurring payments, starting with tokenized fund issuers paying yield to holders.

## 5. Roles

| Role | Who they are | What they can do | What they can see |
|---|---|---|---|
| Treasurer | Runs the fund's treasury | Create the organization, set policy, sign the Mandate, issue fund units, invite holders, instruct the agent, approve proposals, approve or deny audit requests | Everything in their organization |
| Approver | CFO, risk officer, second treasurer | Approve or reject flagged proposals | Proposals, flags, memos, payment history of their organization |
| Holder | An investor in the fund | Accept fund units, turn on auto-receive, view their own payments | Only their own units, payments and statements. Never other holders |
| Auditor | External audit firm | Submit audit requests, view records inside an active access grant | Only records inside an active, unexpired grant |
| Mithra agent | System actor, never a login | Prepare cycles, run checks, write decision records, execute payments within the Mandate, draft audit scopes, close expired grants | What the treasury organization can see |

## 6. Core objects (product language)

- **Organization:** one fund treasury. Has a treasurer, approvers and an approval threshold (for example 2 of 3).
- **Policy:** the rules for distributions. Schedule (for example monthly on the 1st), asset (CC), record date rule, auto-execute cap, approval threshold, and which checks raise flags.
- **Mandate:** the treasurer's signed grant of authority to the agent. The agent may execute a distribution only if: total is at or under the cap, every payee held fund units on the record date, at most one distribution per period, and no blocking flag is open. Changing a Mandate requires a new signature.
- **Fund unit:** a holder's share in the fund. Yield is split pro-rata by units held on the record date.
- **Cycle:** one distribution period (for example "September 2026").
- **Proposal:** the agent's prepared distribution for a cycle: per-holder amounts, checks run, flags, a plain-English memo, and the policy verdict (auto-execute or needs approval).
- **Approval:** an approver's signed decision on a proposal.
- **Payment:** the actual CC transfer to a holder. The payment itself is the record; holders do not co-sign receipts.
- **Decision record:** the agent's audit trail for one action: what triggered it, a fingerprint (hash) of every input it used, the checks run and their results, its memo, the policy verdict, who approved, and the resulting payments.
- **Audit request:** an auditor's plain-English question plus the record scope the AI proposed for it.
- **Access grant:** the treasurer's approval of an audit request. Lists the exact records shared and an expiry. Closed by the agent at expiry.
- **Activity log:** every request, approval, execution, grant and expiry, readable by the treasurer.

## 7. The AI agent

The treasurer works with the agent by prompting it. The agent has tools and acts on the treasurer's behalf, always inside the Mandate.

### What the agent does

1. **Drafts and edits policy from plain English.** "Pay monthly yield on the 1st. Auto-pay under 5,000 CC if nothing looks off, otherwise 2 of 3 approvals." The agent produces a structured policy and a plain-English summary. The treasurer reviews, edits and signs. The agent never signs.
2. **Runs a cycle when told or when the schedule fires.** "Distribute 1,200 CC for September, record date September 30." It snapshots holders on the record date, has code compute pro-rata amounts, runs the checks, reviews the result for anything unusual, writes the memo, and creates the proposal.
3. **Explains.** Answers questions like "why was this flagged?", "what did we pay Holder B this quarter?", "what happens if I raise the cap?"
4. **Drafts audit scopes.** Turns an auditor's plain-English request into the smallest set of records that answers it, with a one-line reason per record.
5. **Housekeeping.** Closes expired access grants, reminds approvers of pending proposals.

### Checks the agent runs on every proposal

Deterministic checks (always run, never decided by the AI):
- Total exceeds the auto-execute cap.
- Treasury balance is insufficient for the total plus fees.
- A payee did not hold units on the record date.
- A distribution already exists for this cycle.
- Total deviates from the trailing average of previous cycles by more than the policy threshold.
- A holder's units changed sharply in the days before the record date.
- The amount was set by a prompt that differs from the policy's fixed amount (if the policy has one).

AI review (advisory, adds context, can raise an advisory flag, cannot clear a deterministic flag):
- Reads the proposal, history and holder changes and writes the memo explaining what is unusual and why it matters.

### What the agent must never do

- Move money outside the Mandate, no matter what it is prompted.
- Sign a Mandate, approve a proposal, or approve an audit request.
- Do the payout arithmetic. Code computes amounts; the AI explains them.
- Show one holder's data to another holder or to an auditor without an active grant.
- Clear a deterministic flag.

If prompted to exceed the Mandate ("pay 50,000 CC now" with a 5,000 cap), the agent creates a proposal that requires approval and tells the treasurer why.

## 8. Feature list

### Must have (MVP)
1. Landing page.
2. Wallet connection and role routing.
3. Organization setup: name, approvers, threshold.
4. AI-drafted policy, editable form, signed Mandate.
5. Fund unit issuance to holders and holder invitation.
6. Holder onboarding: accept units, turn on auto-receive (preapproval).
7. Agent chat with tools (Section 7).
8. Scheduled cycles plus a "Run cycle now" control for demos.
9. Proposal view with per-holder table, checks, flags, memo and verdict.
10. Auto-execution path within the Mandate.
11. Approval path with a live threshold indicator.
12. CC payouts to holders.
13. Holder dashboard showing only their own data.
14. Audit request flow: plain-English request, AI-scoped records, treasurer approval with expiry, read-only evidence room, automatic close at expiry.
15. Decision records for every agent action.
16. Activity log.

### Should have
17. Infrastructure panel showing the treasury party's hosting nodes and threshold (BitSafe; LocalNet only).
18. Seeding scripts that create real demo history on DevNet, labeled as seeded in the UI.

### Out of scope
- Fiat on-ramp, KYC, sanctions screening.
- Assets other than CC (the design must not block USDCx later).
- Payment types other than yield distribution.
- Holder co-signed receipts.
- Mobile app.

## 9. Networks and modes

The app runs in two configured modes. One codebase, a config switch.

**DevNet mode (full product).**
- Runs on the shared HackCanton DevNet node.
- All Mithra records (organization, policy, Mandate, units, proposals, approvals, decision records, audit requests, grants) live on the ledger.
- The agent acts autonomously within the Mandate.
- No wallet supports DevNet (Grofty and Metatarz do not), so users sign through the app's own sign-in against the shared node, with a visible role switcher for demo purposes. The UI must label this as "DevNet test mode".
- CC comes from the DevNet faucet.

**MainNet mode (Grofty segment).**
- Users connect and sign with Grofty Wallet through CIP-0103.
- Holders onboard through Grofty and turn on auto-receive (preapproval).
- The treasurer executes the payout batch by signing in Grofty; real CC moves.
- Small amounts only.
- Limits to verify before building (see Section 11): which Mithra records can exist on MainNet depends on answers from Grofty and on whether Mithra has a MainNet node.

**LocalNet (BitSafe segment).**
- A reproducible setup where the treasury party is hosted across three nodes with a hosting threshold, showing the app keeps working when one node goes offline.

## 10. Demo story (target under 3 minutes for the Grofty video; under 5 for the main pitch video)

1. A treasurer arrives at the landing page and launches the app.
2. Sets up the organization and approvers.
3. Tells the agent the policy in plain English; reviews and signs the Mandate.
4. Issues units to holders; a holder accepts in their wallet and turns on auto-receive.
5. Clean cycle: the treasurer says "distribute 300 CC for September". The agent prepares it, all checks pass, it auto-executes inside the Mandate, holders receive CC.
6. Flagged cycle: one holder's units jumped before the record date and the amount is far above average. The agent flags both, writes a memo, and requires approvals. Two approvers sign; the payment executes.
7. A holder's view shows only their own payments.
8. An auditor asks "show Q3 distributions and the approvals behind any flagged one". The agent proposes a scope; the treasurer approves for 7 days; the auditor opens the evidence room; the grant later expires.
9. Short infrastructure segment: one hosting node goes offline, the app keeps running (LocalNet).

## 11. Open questions to resolve before or during the build

1. **Grofty and custom Daml.** Grofty submits only as the connected user's party. Can Grofty users sign commands against Mithra's own Daml package on MainNet? That requires the package to be accepted on the node hosting Grofty users. Ask the Grofty team. If not, MainNet mode is limited to standard CC actions (auto-receive setup, transfers) and Mithra-specific records stay in the app on MainNet.
2. **Mithra on MainNet.** The agent and organization records need a MainNet node to live on-ledger. Without one, MainNet mode uses treasurer-signed Grofty transfers and app-side records.
3. **Explorer visibility.** Public explorers should show CC transfers but not Mithra's private records. Confirm on the DevNet explorer early.
4. **LLM endpoint.** The builder uses the Z.ai Coding Plan endpoint. Z.ai's docs say that plan is limited to supported tools. Keep the provider configurable.
5. **BitSafe.** The shared DevNet node cannot host decentralized parties; the BitSafe segment runs on LocalNet.

## 12. Glossary

- **CC:** Canton Coin, the network's native token, used for payments and fees.
- **Party:** an identity on Canton (like an account).
- **Auto-receive (preapproval):** a holder's standing permission to receive CC without clicking accept each time.
- **Record date:** the date whose unit holdings decide who gets paid and how much.
- **Pro-rata:** split in proportion to units held.
- **Mandate:** the agent's signed, ledger-enforced spending authority.
- **Decision record:** the agent's recorded reasoning and inputs for one action.
- **Access grant:** an auditor's time-limited view of specific records.
