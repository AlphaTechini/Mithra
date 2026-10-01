# Mithra build kickoff

Paste Section 1 into your coding agent as the first message. Sections 2 and 3 are templates the orchestrator uses; they are also referenced from Section 1, so keep this file in the repo.

---

## 1. Kickoff prompt (paste this)

You are the **orchestrator** for building Mithra, a Canton Network app for the HackCanton Season 3 hackathon. The submission deadline is **October 9, 2026, 23:59 UTC**. Aim to have the happy path working by **October 7** so there is time for demo videos.

### Your role vs. the implementer

- **You (orchestrator):** read and understand the product, research current APIs, plan milestones, write detailed implementation briefs, review every result against the specs, run tests, integrate, and commit. You do not write feature code yourself except small fixes during review.
- **Implementer:** a subagent running **Sonnet 5.5** (`claude-sonnet-5-5`; use the alias `sonnet` if your subagent tool takes aliases). The implementer writes all the code and tests for each milestone, from your brief.
- After each milestone, you review the implementer's work. If it fails review, send it back with a specific fix list. When everything is done, run a final full review (Section 3).

### Read first, in full

1. `details.md`: what the product is, roles, objects, the AI agent's jobs and limits, networks, demo story.
2. `userflow.md`: every screen, the design system (palette, type, the seal, vocabulary), states, accessibility.
3. `specs.md`: numbered requirements with acceptance checks, the tech stack, and the build order.

These three files are the source of truth. If they conflict, `specs.md` wins for requirements, `userflow.md` for UI, `details.md` for product meaning. Do not change product scope. If something is genuinely ambiguous about the product (not about implementation), ask the product owner one concise question and continue with other work meanwhile.

### Ground rules

- **Nothing is mocked** unless the product owner explicitly says so. Demo actors are real parties; payments are real CC transfers on the configured network.
- **Never block on credentials.** All endpoints, party IDs and keys come from environment variables the product owner sets. List every variable in `.env.example` with a one-line description, and fail at startup with a clear message naming any missing one.
- **Networks:** only `localnet` and `mainnet`. No DevNet, no TestNet.
- **Architecture:** Fastify is the entire backend (API, ledger access, agent, scheduler, grant expiry, server-side transfers). SvelteKit is frontend only, multi-page with SvelteKit routing, getting all data from the Fastify API. Grofty signing happens in the browser on MainNet.
- **LLM:** OpenAI API via the official `openai` SDK with tool calling; `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` from env.
- **Money:** decimal arithmetic only. The LLM never computes amounts.
- **Ledger rules are enforced in Daml**, not just in the UI (specs Section 1, L1 to L11).
- Commit after each milestone passes review, with a clear message. Push to `main`.

### Step 0: environment check and research (you do this, before any brief)

1. Check what this environment can do: `node -v`, `pnpm -v`, `docker info`, whether `dpm` / the Daml SDK can be installed, and network access to package registries. If Docker or the Daml SDK is unavailable here, the implementer still writes the Docker Compose files, scripts and Daml code; mark the runtime steps as "verify on owner's machine" in `docs/verification.md` instead of skipping them.
2. Research the current, real APIs and record verified findings with source links in `docs/research/`:
   - `daml.md`: current Daml SDK and `dpm` usage, Daml Script test setup, how to depend on the Canton token standard (CIP-56) interfaces.
   - `ledger-api.md`: JSON Ledger API v2 endpoints for submitting commands, querying active contracts, streaming updates, party allocation, DAR upload, auth.
   - `localnet.md`: how to run Canton LocalNet with three participants via Docker Compose (start from the official cn-quickstart / LocalNet docs), how CC is minted locally, how to get a registry/scan endpoint for token standard transfers.
   - `bitsafe-dm.md`: BitSafe's Decentralization Manager (github.com/DLC-link/decentralization-manager): creating a Decentralized Party across three nodes, hosting and confirmation thresholds, how an app's governed action is wired in.
   - `wallet-sdk.md`: `@canton-network/wallet-sdk` for transfers and preapprovals (TransferFactory, registry URL, preapproval commands).
   - `grofty.md`: `@groftylabs/dapp-sdk` and CIP-0103 (`connect`, `getPrimaryAccount`, `prepareExecuteAndWait`), Grofty constraints (MainNet only, single-party submission, 3-minute approval expiry with error -32603, version 2.0.4+, preapproval for receiving).
   - `openai.md`: tool calling with the official SDK, structured outputs for tool arguments.
   Only record what you verified from docs or source. Mark anything unverified as such. Include the relevant findings in each implementer brief so the implementer does not guess APIs.
3. Write `docs/plan.md`: the milestones below, each with the spec IDs it covers, its dependencies, and which milestones can run in parallel without touching the same files.

### Milestones (follow specs Section 8 build order)

| ID | Milestone | Covers |
|---|---|---|
| M0 | Monorepo scaffold: pnpm workspace, `daml/`, `apps/backend` (Fastify, TS strict), `apps/web` (SvelteKit, Svelte 5, frontend only), `packages/shared` (types, Zod schemas), `.env.example`, lint and format, root scripts | T1 to T5, N1 |
| M1 | Daml model and Daml Script tests | L1 to L11 |
| M2 | LocalNet: Docker Compose with three participants and the Decentralization Manager; scripts to bring it up, upload the DAR, allocate demo parties, create the treasury Decentralized Party (hosting threshold 2 of 3), mint CC | N2, N7, T4 |
| M3 | Backend foundation: config and env validation, ledger client module, auth, PostgreSQL with Drizzle for app-side data, role resolution, seeding script | N1 to N3, T2, T5 |
| M4 | Cycle engine: record-date snapshot, pro-rata in decimal, all deterministic checks, decision records, auto-execute vs approval verdict, payments via the token standard, balance check | L1 to L4, L10, A3, A4, P1, P2, P4, P5 |
| M5 | Agent: OpenAI client, tool set from specs Section 2, guardrails, fail-safe behavior, scheduler with no double runs, grant expiry job, Server-Sent Events for the live timeline | A1 to A12 |
| M6 | Frontend foundation: design tokens, self-hosted fonts, layouts per role, seal component, agent timeline component, agent panel, API client, network badge, role switcher (LocalNet), loading/empty/error/pending patterns | U2 to U5, U9, N3 |
| M7 | Treasurer screens: setup (organization, AI-drafted policy, seal mandate), overview, holders, cycle page with Hold countdown, activity, settings including Infrastructure panel | U1, U6, userflow 4, 5, 7, 8, 9, 12 |
| M8 | Approver and holder screens, holder onboarding with auto-receive, holder isolation | L5, L7, U7, P2, userflow 6, 10 |
| M9 | Audit flow: request with AI-drafted scope, treasurer grant/deny with expiry, evidence room, automatic close, activity log | L8, L9, A8, A9, userflow 11 |
| M10 | MainNet with Grofty: wallet connection in the browser, signing via `prepareExecuteAndWait`, holder auto-receive onboarding, payout signed by the treasurer, error handling for expiry and missing extension | N4 to N6, P3 |
| M11 | BitSafe evidence: node-offline test (cycle still runs on 2 of 3), below-threshold governed action fails and succeeds once met, node and operator list in README | N8, S5 |
| M12 | Landing page, Playwright happy-path test, accessibility pass, README, `docs/traceability.md` | U1, U5, S1, S2 |

Parallel-safe pairs (different directories): M1 with M6; M4 with M6; M9 frontend with M10 backend parts only if briefs assign disjoint files. Never run two implementers on the same files.

### How to run each milestone

1. Write a brief using the template in Section 2 of `prompts/kickoff.md`. Paste the relevant spec rows verbatim, the relevant research findings, exact file paths, interfaces, and acceptance checks. The implementer should not need to read anything else to do the job, but tell it which of the three docs to consult for context.
2. Spawn the implementer subagent with model Sonnet 5.5 and the brief.
3. When it reports back, review using the checklist in Section 3 of `prompts/kickoff.md`: read the diff, run the tests yourself, and check every acceptance item.
4. If anything fails, send the same implementer a numbered fix list with file and line references. Repeat until it passes. If the same issue fails three times, fix it yourself or simplify the approach, and note it in `docs/decisions.md`.
5. Commit and push. Update `docs/plan.md` status and `docs/traceability.md` (spec ID, file paths, test name, status).

### Priorities if time runs short

Keep, in this order: ledger guarantees (L1 to L11), cycle engine, agent with guardrails, treasurer and approver happy path, holder isolation, audit flow, Grofty on MainNet, BitSafe evidence, landing page polish. Drop "should have" items before cutting any MUST. Tell the product owner before dropping anything.

### Reporting to the product owner

After each milestone: one short message with what now works, how to try it, which spec IDs passed, and anything that needs the owner (for example environment variables to set or a step to verify on their machine).

Start now with Step 0.

---

## 2. Implementer brief template (orchestrator fills this in)

```
You are the implementer for milestone {ID}: {name}, in the Mithra repository.
Write all code and tests for this milestone. Do not change anything outside the files listed unless the brief says so.

## Goal
{One paragraph: what will work when you are done, in user terms.}

## Context
- Product: see details.md sections {x}; UI: userflow.md sections {y}; requirements: specs.md rows below.
- Architecture: Fastify is the whole backend (apps/backend); SvelteKit is frontend only (apps/web); shared types and Zod schemas in packages/shared; Daml in daml/.
- Networks: localnet and mainnet only, selected by NETWORK env var. All endpoints, party IDs and keys come from env.
- Nothing is mocked. Money uses decimal arithmetic. The LLM never computes amounts.

## Requirements (verbatim from specs.md)
{paste the rows}

## Verified API notes
{paste the relevant findings from docs/research/, with exact function names, endpoints and payload shapes}

## Files to create or change
{exact paths, with one line each on purpose}

## Interfaces you must match
{type signatures, API routes with request and response schemas, Daml template and choice names, event names}

## Acceptance checks you must run and pass
{commands and expected results, for example: `dpm test` passes all scripts including L4 rejection case; `pnpm --filter backend test` passes; `curl` example}

## Constraints
- TypeScript strict; no `any` without a comment explaining why.
- No secrets in code; add every new env var to .env.example with a description.
- Follow userflow.md vocabulary and design tokens for any UI.
- Handle loading, empty, error and pending states for any UI.
- Do not mock network calls in the app itself (tests may stub external services).

## When you finish, report
1. Files changed.
2. Exact commands you ran and their output (tests, build, lint).
3. Each acceptance check: pass or fail, with evidence.
4. Anything you could not do, any deviation from the brief, and why.
5. Open questions for the orchestrator.
```

---

## 3. Review checklist (orchestrator uses after every milestone, and once at the end over the whole repo)

**Correctness**
- Every spec row in the brief is implemented and its acceptance check passes when you run it yourself, not just as reported.
- Ledger guarantees are enforced in Daml with both success and rejection tests, not only in backend or UI code.
- Amounts are decimal end to end; no float conversion anywhere, including JSON serialization.
- The LLM output is never used as an amount, approval, signature or grant.
- Scheduler cannot double-run a cycle after a restart.

**Privacy and security**
- A holder's API responses and pages never include another holder's data (test it with two holder sessions).
- An auditor sees nothing outside an active grant; expired grants return nothing.
- No secrets committed; `.env.example` complete; startup fails clearly on a missing variable.
- Server validates every input with Zod; the frontend is never trusted for authorization.

**Product fidelity**
- Screens match `userflow.md`: layout per role, vocabulary table, Saffron only for seal moments, seal shows true ledger signature count, "Paid" only after ledger confirmation.
- Loading, empty, error and pending states exist and read as described.
- Works at 375 px, keyboard accessible, reduced motion respected.

**Quality**
- Builds, lints and tests pass from a clean install.
- No dead code, placeholder TODOs in the happy path, or commented-out blocks.
- README and `docs/` updated for anything new the owner must run or set.

**Final review only**
- `docs/traceability.md` lists every spec ID with code location, test and status; no MUST is left unmet without the owner's sign-off.
- Run the full happy path from `userflow.md` Section 0 on LocalNet end to end and record the result in `docs/verification.md`.
- Produce a short final report for the owner: what works, what was cut, environment variables to set, steps to verify on their machine, and the demo script.
