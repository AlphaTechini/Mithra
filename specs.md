# Mithra: requirements

Requirements that must be met. Each has an ID and an acceptance check. "MUST" is mandatory for submission; "SHOULD" is strongly expected; "MAY" is optional. Read `details.md` for product meaning and `userflow.md` for screens.

Global rules for the builder:
- Nothing is mocked unless the product owner explicitly says so. Demo actors (treasury, approvers, holders, auditor) are real parties; payments are real CC transfers on the configured network.
- Build the full happy path for every network mode. All credentials, endpoints, party IDs and API keys come from environment variables that the product owner sets. Never block on missing credentials: read them from config, list them in `.env.example`, and fail with a clear message at startup if one is missing.

## 1. Ledger guarantees (the core of the product)

These are enforced by the Daml contracts, not only by the UI or backend. Each MUST have a Daml Script test proving both the success and the rejection case.

| ID | Requirement | Acceptance |
|---|---|---|
| L1 | The agent can execute a distribution only through the Mandate, and only if the total is at or under the Mandate cap. | Script: total = cap succeeds; total = cap + 0.0000000001 fails. |
| L2 | Every payee in an agent-executed distribution held fund units on the record date, and each amount equals the pro-rata share computed from the record-date snapshot (with a documented rounding rule). | Script: adding a non-holder fails; altering one amount fails. |
| L3 | At most one distribution per cycle per organization. | Script: second execution for the same cycle fails. |
| L4 | A proposal that needs approval cannot execute below the organization's threshold, and executes once the threshold is met. | Script: 1 of 2 fails; 2 of 2 succeeds. |
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
| P3 | On MainNet, each payment MUST link to its transaction on a network explorer. On LocalNet, each payment links to its in-app transaction detail. | Link opens the transfer. |
| P4 | The UI MUST NOT show "Paid" until the ledger confirms the transfer. | Test with a slow or failed submission. |
| P5 | Before executing, the system MUST check the treasury balance covers the total plus an estimated fee buffer; if not, block with "Add funds". | Test with low balance. |

## 4. Networks and wallets

| ID | Requirement | Acceptance |
|---|---|---|
| N1 | One codebase, network chosen by configuration: `localnet` or `mainnet`. | Switching config changes endpoints and wallet behavior without code changes. |
| N2 | **LocalNet:** a Docker Compose setup with three participant nodes plus BitSafe's Decentralization Manager. One command brings it up from a clean machine. Endpoints come from environment variables, never hard-coded. | Fresh clone plus documented commands runs the full happy path. |
| N3 | **LocalNet:** since no wallet supports LocalNet, the app signs server-side with a visible role switcher and a persistent "LocalNet test mode" badge. | Badge visible on every screen in LocalNet. |
| N4 | **MainNet:** Grofty Wallet is how users connect, sign and transact, through CIP-0103 or `@groftylabs/dapp-sdk`. Use `prepareExecuteAndWait()`. Handle Grofty specifics: single-party submission only (no `actAs` for others), approvals expire after 3 minutes (error -32603), Grofty Wallet 2.0.4 or newer required. | End-to-end MainNet demo with small amounts. Not pursued for the submission (decision 14). |
| N5 | **MainNet:** holder onboarding MUST guide the user through turning on auto-receive (preapproval) in Grofty. | Demonstrated in the Grofty video. Not pursued for the submission (decision 14). |
| N6 | **MainNet:** uses the same Daml package and the same flows as LocalNet. Treasurer, approver, holder and auditor actions are signed by each user's own Grofty party. The agent and operator parties, ledger endpoints and package IDs come from environment variables. | MainNet config runs the same happy path as LocalNet. |
| N7 | **BitSafe (LocalNet):** the treasury organization's party is a Decentralized Party created with BitSafe's Decentralization Manager, hosted on all three nodes with a hosting threshold of 2. Each node is named with its operator. | README lists nodes, operators, thresholds. |
| N8 | **BitSafe (LocalNet):** demonstrate one node going offline while a cycle still executes, and the app's behavior below the hosting threshold. Demonstrate that a governed action (Mandate change) cannot execute below its confirmation threshold and succeeds once met. | Recorded test results in the repo. |

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

## 6. Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript everywhere (strict mode), except Daml for contracts |
| Package manager | pnpm, single repository |
| Smart contracts | Daml, built and tested with `dpm` (Daml Script tests), targeting the Canton version of the configured network |
| Token standard | Canton token standard (CIP-56) interfaces for holdings and transfers; CC via the network's registry |
| Repository layout | Monorepo: `daml/` (contracts), `apps/backend` (Fastify), `apps/web` (SvelteKit), `packages/shared` (types and Zod schemas shared by both) |
| Backend | One Fastify server (Node.js, TypeScript). It is the entire backend: REST API for the frontend, ledger access, the AI agent, the scheduler, grant expiry, and server-side transfers. One process to deploy |
| Frontend | SvelteKit with Svelte 5, frontend only, multi-page using SvelteKit routing. No business logic or ledger access in SvelteKit server routes; all data comes from the Fastify API. Grofty signing runs in the browser |
| Scheduling | `croner` (or equivalent) inside the Fastify process, with cycle runs recorded in the database so restarts never double-run a cycle |
| Realtime | Server-Sent Events from Fastify for the live agent timeline and status updates |
| Ledger access | JSON Ledger API v2 over HTTPS, OIDC client-credentials or password-grant tokens from the configured identity provider |
| Wallet / transfers SDKs | `@canton-network/wallet-sdk` for party, transfer and preapproval operations on the server side; `@groftylabs/dapp-sdk` (CIP-0103) for user signing on MainNet |
| App database | PostgreSQL with Drizzle ORM, for app-side data only: sessions, invites, chat history, cached ledger views, job state. The ledger stays the source of truth for every product record in `details.md` Section 6 |
| LLM | OpenAI API through the official `openai` SDK (Chat Completions with function/tool calling), so any OpenAI-compatible provider works. `LLM_BASE_URL` (default `https://api.openai.com/v1`), `LLM_API_KEY`, `LLM_MODEL` from env |
| Validation | Zod for all API inputs and all LLM tool-call arguments |
| Decimal math | `decimal.js` (or Daml `Decimal` on-ledger). Never JavaScript floating point for amounts |
| Styling | Plain CSS with custom properties for the tokens in `userflow.md` Section 1; no component library that imposes its own look |
| Fonts | Newsreader and Public Sans, self-hosted |
| Testing | Daml Script (contracts), Vitest (backend domain, agent checks, pro-rata), Playwright (happy path in the browser) |
| LocalNet | Docker Compose: Canton LocalNet with three participants plus BitSafe's Decentralization Manager |
| Config | `.env` per network; `NETWORK=localnet|mainnet` selects endpoints and signing mode |

Constraints:

| ID | Constraint |
|---|---|
| T1 | The frontend never talks to the ledger or the LLM directly, except Grofty wallet signing in the browser. Everything else goes through the Fastify API. |
| T2 | No secrets in the repository. `.env.example` lists every variable with a one-line description. |
| T3 | All amounts use decimal arithmetic. |
| T4 | Seeding scripts that create demo history on LocalNet live in `scripts/` and are idempotent. |
| T5 | Ledger, wallet and LLM access each sit behind one module, so swapping a network, wallet or model provider changes config, not feature code. |

## 7. Submission requirements

| ID | Requirement |
|---|---|
| S1 | Public GitHub repository. |
| S2 | README: what Mithra is, how to bring up LocalNet (including the BitSafe setup) from a clean machine, how to run the frontend and backend against LocalNet and MainNet, how the Grofty integration works and how to run it (required by the Grofty bounty). |
| S3 | Grofty demo video, 3 minutes or less, showing the Grofty flow end to end on MainNet. Not pursued for the submission (decision 14). |
| S4 | Main demo video following the demo story in `details.md` Section 10. |
| S5 | BitSafe evidence: test results for the hosting and threshold behavior, node and operator list, thresholds, remaining work and a named technical owner. |
| S6 | Submitted to Track 3 by October 9, 2026, 23:59 UTC. |

## 8. Build order (suggested)

1. Daml model plus Script tests for L1 to L11.
2. LocalNet setup with three nodes and the Decentralized Party; ledger client; seeding script.
3. Cycle engine: snapshot, pro-rata, deterministic checks, decision records.
4. Agent with tools and the LLM client.
5. Treasurer screens: setup, overview, cycle, approvals.
6. Holder screens.
7. Audit flow.
8. MainNet Grofty path.
9. Landing page, polish, videos.
