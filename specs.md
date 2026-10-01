# Mithra: requirements

Requirements that must be met. Each has an ID and an acceptance check. "MUST" is mandatory for submission; "SHOULD" is strongly expected; "MAY" is optional. Read `details.md` for product meaning and `userflow.md` for screens.

Global rules for the builder:
- Nothing is mocked unless the product owner explicitly says so. Demo actors (treasury, approvers, holders, auditor) are real parties; payments are real CC transfers on the configured network.
- When a requirement conflicts with what the network or a wallet actually supports, stop and report it to the product owner instead of faking it.

## 1. Ledger guarantees (the core of the product)

These are enforced by the Daml contracts, not only by the UI or backend. Each MUST have a Daml Script test proving both the success and the rejection case.

| ID | Requirement | Acceptance |
|---|---|---|
| L1 | The agent can execute a distribution only through the Mandate, and only if the total is at or under the Mandate cap. | Script: total = cap succeeds; total = cap + 0.0000000001 fails. |
| L2 | Every payee in an agent-executed distribution held fund units on the record date, and each amount equals the pro-rata share computed from the record-date snapshot (with a documented rounding rule). | Script: adding a non-holder fails; altering one amount fails. |
| L3 | At most one distribution per cycle per organization. | Script: second execution for the same cycle fails. |
| L4 | A proposal that needs approval cannot execute below the organization's threshold, and executes once the threshold is met. | Script: 1 of 2 fails; 2 of 2 succeeds. Matches the BitSafe "show it can't execute below threshold" expectation. |
| L5 | An approver can approve a given proposal at most once; non-approvers cannot approve. | Script: duplicate approval fails; outsider approval fails. |
| L6 | Changing the Mandate (cap, threshold, schedule, asset) requires a new treasurer signature. The agent cannot modify it. | Script: agent-submitted change fails. |
| L7 | A holder can see only their own units and payments. | Script or ledger query test: holder A's view contains no holder B data. |
| L8 | An auditor sees records only through an active access grant, and only the records listed in it. | Script: auditor query before grant returns nothing; after grant returns exactly the listed records. |
| L9 | An access grant has an expiry. After expiry, the agent (or any stakeholder) can close it, and the auditor loses visibility of the shared records. | Script: close after expiry succeeds, auditor view empty afterward; close before expiry by the agent fails. |
| L10 | Every agent-executed or agent-proposed distribution produces a decision record containing: trigger, input fingerprints (hashes), checks with results, memo, verdict, approvals, and payment references. | Script: execution without a decision record is impossible by construction. |
| L11 | The treasurer can cancel a pending, unexecuted proposal. | Script. |

## 2. Agent behavior

| ID | Requirement | Acceptance |
|---|---|---|
| A1 | MUST draft a policy from plain English into the structured fields defined in `details.md` Section 6, plus a plain-English summary. The draft is never applied without the treasurer sealing it. | Demo prompt produces a valid policy; nothing changes on-ledger until "Seal mandate". |
| A2 | MUST create a cycle proposal from a prompt containing an amount and period, and from the schedule. | Both triggers produce a proposal. |
| A3 | MUST compute amounts in code (not in the LLM). | Unit test: proposal amounts equal the pure function's output; LLM output is never used as an amount. |
| A4 | MUST run all deterministic checks listed in `details.md` Section 7 on every proposal, with actual values shown. | Unit tests per check. |
| A5 | MUST write an advisory review memo; the AI may add advisory flags but cannot clear deterministic flags. | Test: a deterministic flag persists regardless of model output. |
| A6 | When prompted to exceed the Mandate, MUST create an approval-required proposal and explain why, never execute. | Prompt "pay 50,000 CC now" with a 5,000 cap yields a proposal needing approval. |
| A7 | MUST NOT sign mandates, approve proposals, or grant audit access. Its party has no rights to do so. | Ledger rights check plus attempted calls fail. |
| A8 | MUST draft audit scopes from plain English as a list of record IDs, each with a reason, preferring the smallest set that answers the request. | Demo request produces a scope the treasurer can inspect record by record. |
| A9 | MUST close expired grants automatically within 5 minutes of expiry. | Integration test with a short expiry. |
| A10 | Agent tool calls MUST be visible in the UI as action cards. | UI check. |
| A11 | If the LLM is unavailable or returns invalid output, the agent MUST fail safe: no execution, a clear error, and deterministic checks still shown. | Test with the LLM endpoint disabled. |
| A12 | Prompts and model responses for each decision MUST be fingerprinted in the decision record. | Inspect a decision record. |

Agent tool set (minimum): `draft_policy`, `propose_mandate_change`, `list_holders`, `issue_units`, `invite_holder`, `get_balance`, `create_cycle`, `run_cycle_now`, `explain_proposal`, `query_history`, `draft_audit_scope`, `close_expired_grants`.

## 3. Payments

| ID | Requirement | Acceptance |
|---|---|---|
| P1 | Payments MUST be real CC transfers using the Canton token standard (CIP-56) interfaces, so USDCx can be added later without redesign. | Code review: no CC-specific shortcuts outside an asset adapter. |
| P2 | Holders with auto-receive (preapproval) MUST be paid in one step; holders without it MUST receive a pending transfer and the UI MUST show it as awaiting acceptance. | Both cases demonstrated. |
| P3 | Each payment MUST link to its transaction on the network explorer where the explorer can show it. | Link opens the transfer. |
| P4 | The UI MUST NOT show "Paid" until the ledger confirms the transfer. | Test with a slow or failed submission. |
| P5 | Before executing, the system MUST check the treasury balance covers the total plus an estimated fee buffer; if not, block with "Add funds". | Test with low balance. |

## 4. Networks and wallets

| ID | Requirement | Acceptance |
|---|---|---|
| N1 | One codebase, network chosen by configuration: `devnet`, `mainnet`, `localnet`. | Switching config changes endpoints and wallet behavior without code changes. |
| N2 | **DevNet:** connect to the shared HackCanton node (JSON Ledger API, OIDC token from the Noders Keycloak realm). Endpoints come from environment variables, never hard-coded. | App runs against the shared node. |
| N3 | **DevNet:** since no wallet supports DevNet, the app signs via the shared node with a visible role switcher and a persistent "DevNet test mode" badge. | Badge visible on every screen in DevNet. |
| N4 | **MainNet:** Grofty Wallet is how users connect, sign and transact, through CIP-0103 or `@groftylabs/dapp-sdk`. Use `prepareExecuteAndWait()`. Handle Grofty specifics: single-party submission only (no `actAs` for others), approvals expire after 3 minutes (error -32603), Grofty Wallet 2.0.4 or newer required. | End-to-end MainNet demo with small amounts. |
| N5 | **MainNet:** holder onboarding MUST guide the user through turning on auto-receive (preapproval) in Grofty. | Demonstrated in the Grofty video. |
| N6 | Before building MainNet features that need custom Daml signatures from Grofty users, the builder MUST confirm with the Grofty team that Mithra's package can be used from Grofty-hosted parties. If not, report to the product owner; do not fake it. | Written confirmation or a reported limitation. |
| N7 | **LocalNet (BitSafe):** a reproducible setup where the treasury organization's party is a Decentralized Party hosted on three named nodes with a stated hosting threshold, using BitSafe's Decentralization Manager. | Clean-environment setup instructions work. |
| N8 | **LocalNet (BitSafe):** demonstrate one node going offline while a cycle still runs, and report behavior when below threshold. Name each node and its operator and state which are independent. | Recorded test and README section. |

## 5. UI and UX

| ID | Requirement | Acceptance |
|---|---|---|
| U1 | Implement every screen in `userflow.md` Sections 2 to 12. | Walkthrough of the happy path with no dead ends. |
| U2 | Use the design tokens in `userflow.md` Section 1 (palette, type, seal, vocabulary). Saffron is used only for seal moments. | Visual review. |
| U3 | The seal ring reflects the true signature count from the ledger, never an optimistic local value. | Test with a delayed approval. |
| U4 | Every screen handles loading, empty, error and pending states as described in `userflow.md` Section 13. | Review each screen. |
| U5 | Works at 375 px width; keyboard accessible; WCAG AA contrast; reduced-motion respected. | Lighthouse accessibility score at least 90; manual keyboard pass. |
| U6 | The auto-execute path shows a short countdown with a "Hold" button before submitting. | Demo. |
| U7 | Holder screens never render another holder's name, units or amounts, even in errors or tooltips. | Review plus L7 test. |
| U8 | Seeded demo data is tagged "Seeded" in the UI. | Visual check. |
| U9 | Copy follows the vocabulary table; buttons say exactly what happens. | Copy review. |

## 6. Technical constraints

| ID | Constraint |
|---|---|
| T1 | Smart contracts in Daml, built and tested with `dpm`, compatible with the shared node's Canton version. |
| T2 | Web app in SvelteKit (Svelte 5) using adapter-node; server routes act as the backend. |
| T3 | Scheduler and agent run as a separate long-running worker process in the same repository, sharing code with the web app. No long-running loops inside request handlers. |
| T4 | Ledger access through the JSON Ledger API v2. |
| T5 | LLM access through a single configurable client (base URL, API key, model in environment variables). Default: the Z.ai Coding Plan endpoint the product owner provides. Switching providers must require only config changes. |
| T6 | No secrets in the repository. `.env.example` lists every variable. |
| T7 | All amounts use decimal arithmetic, never floating point. |
| T8 | Seeding scripts that create demo history on DevNet live in `scripts/` and are idempotent. |

## 7. Submission requirements

| ID | Requirement |
|---|---|
| S1 | Public GitHub repository. |
| S2 | README: what Mithra is, how to run DevNet mode, how to run the LocalNet BitSafe setup from a clean machine, how the Grofty integration works and how to run it (required by the Grofty bounty). |
| S3 | Grofty demo video, 3 minutes or less, showing the Grofty flow end to end on MainNet. |
| S4 | Main demo video following the demo story in `details.md` Section 10. |
| S5 | BitSafe evidence: test results or recordings for the threshold and node-offline behavior, node and operator list, thresholds, remaining work and a named technical owner. |
| S6 | Submitted to Track 3 by October 9, 2026, 23:59 UTC. |

## 8. Build order (suggested)

1. Daml model plus Script tests for L1 to L11.
2. Ledger client and DevNet connection; seeding script.
3. Cycle engine: snapshot, pro-rata, deterministic checks, decision records.
4. Agent with tools and the LLM client.
5. Treasurer screens: setup, overview, cycle, approvals.
6. Holder screens.
7. Audit flow.
8. MainNet Grofty path (after N6 is answered).
9. LocalNet BitSafe setup.
10. Landing page, polish, videos.
