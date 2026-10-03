# Mithra

Mithra is a treasury app on Canton where an AI agent runs a fund's recurring yield distributions on schedule, inside spending limits the ledger enforces, and gives auditors scoped, time-limited, logged access to exactly the records they ask for. A treasurer tells the agent the policy in plain English and seals it as a **Mandate**; the agent prepares every cycle, runs the checks, writes the memo and pays inside the Mandate; flagged cycles wait for the approvers; an auditor sees only the records the treasurer grants, for as long as the treasurer grants them. Built for HackCanton Season 3, Track 3 (Investment Infrastructure), entered in the Grofty Wallet and BitSafe challenges.

**What to look at first:** the landing page of the running app, [docs/demo-script.md](docs/demo-script.md) (the 5-minute story), [docs/traceability.md](docs/traceability.md) (every requirement with its code and tests), and the one Playwright test that walks the whole story in a browser (`pnpm e2e`).

## The problem

| Figure                                                                                               | Source                 |
| ---------------------------------------------------------------------------------------------------- | ---------------------- |
| 88% of US companies report payment operations problems                                               | Modern Treasury, 2025  |
| $894M paid on a Revlon loan in 2020 when $7.8M of interest was meant, after three people reviewed it | Citibank as loan agent |
| 10 to 25 business days for one bank confirmation                                                     | Chase, NatWest         |

AI can prepare payments, but a fund cannot let it hold the keys. And on Canton an auditor added as an observer "sees everything"; Canton's docs tell builders to "use workflow patterns to grant temporary audit access" but do not ship one. Mithra is that pattern, plus an agent that cannot go outside its limits.

## How it works

| Role             | What they do                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Treasurer        | Creates the organization, describes the policy to the agent, **seals the Mandate**, issues fund units, runs cycles, grants or denies audit access |
| Approvers        | Approve or reject flagged proposals; two of three (configurable) must approve                                                                     |
| Holders          | Accept units, turn on auto-receive, see only their own units and payments                                                                         |
| Auditor          | Asks a question in plain English; sees only the records in an active, unexpired grant                                                             |
| The Mithra agent | A system actor, never a login                                                                                                                     |

**What the agent does:** drafts the policy from plain English (the treasurer reviews and seals; the agent never signs), runs a cycle on schedule or on request (snapshot of who held units on the record date, pro-rata amounts **computed by code**, seven deterministic checks, an advisory AI review and memo), explains flags, drafts audit scopes, closes expired grants. **What it cannot do:** move more than the cap without approvals, sign or change the Mandate, approve a proposal, grant audit access, do the arithmetic, clear a deterministic flag, show one holder's data to another. If you ask for more than the cap ("pay 50,000 CC now" against 5,000), it prepares a proposal that needs approvals and says so.

**The Mandate is enforced by Daml, not by the app.** The cap, "every payee held units on the record date", "each amount is the pro-rata share", "one distribution per cycle" and "approvals needed above the cap" are checked inside the ledger choices, so a bug or a bad prompt in the backend still cannot break them (tests for each, success and rejection, in `daml/mithra-tests`). Authority flows like this (details in [docs/ledger-model.md](docs/ledger-model.md)):

```
 BitSafe GovernanceRules (treasury party, 2 of 3 nodes)
   |  governed action: CharterProposal
   v
 TreasuryCharter ----------------------> Organization (treasury + treasurer), UnitRegister
 treasurer signs MandateSealRequest
   |  governed action: MandateChangeProposal  -> Org_ApplySeal
   v
 Mandate  (cap, approvers, threshold, schedule; no choice changes it: L6)
   |-- Mandate_Propose            (agent)    -> DecisionRecord + Proposal (+ Mandate recreated with the attempt)
   |-- Proposal_Approve           (approver) -> approvals counted on the ledger (L4, L5)
   '-- Mandate_AgentExecute       (agent)    -> one CIP-56 transfer per payee (checks L1, L2, L3)
                                              + Payment per payee + DistributionOutcome
 Org_GrantAccess (treasurer) -> AccessGrant + SharedRecord copies for the auditor (L8)
 AccessGrant_CloseExpired    (anyone, after expiry) archives them (L9)
```

**Audit grants.** Canton has no revocable observers, so a grant copies exactly the records it lists into `SharedRecord` contracts visible to the auditor and archives them at expiry or when the treasurer ends access. The auditor sees holders as "Holder A to D", never as names or party ids.

## Repository layout

| Path              | What it is                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `apps/backend`    | Fastify API: the whole backend in one process (ledger access, agent, scheduler, grant expiry, SSE) |
| `apps/web`        | SvelteKit 2 / Svelte 5 frontend only, a static SPA that talks to `/api`                            |
| `packages/shared` | Shared types, Zod schemas and decimal helpers (`@mithra/shared`)                                   |
| `daml`            | Daml model (`mithra`), Daml Script tests (`mithra-tests`), vendored DARs (`dars`)                  |
| `localnet`        | Docker Compose for LocalNet: three nodes and one BitSafe Decentralization Manager per node         |
| `scripts`         | LocalNet bring-up, status and node on/off, Daml helper, sandbox, seeding, BitSafe evidence run     |
| `e2e`             | The Playwright happy path (`pnpm e2e`)                                                             |
| `docs`            | Ledger model, BitSafe, verification, demo script, decisions, traceability, accessibility, research |

## Quick start on LocalNet (from a clean machine)

**Prerequisites:** Docker with about 8 GB of memory (compose plugin 2.24 or newer), Node 22, pnpm 10 (`corepack enable`), `jq`, `curl`, `openssl`, PostgreSQL 16 for the app database (a local install or `docker run -p 5432:5432 -e POSTGRES_USER=mithra -e POSTGRES_PASSWORD=mithra -e POSTGRES_DB=mithra postgres:16`), and either `dpm` 3.4.11 or nothing more than Docker (`scripts/daml.sh` falls back to the `digitalasset/daml-sdk` image). You also need an OpenAI-compatible API key for the agent.

```sh
git clone https://github.com/AlphaTechini/Mithra && cd Mithra

scripts/localnet-up.sh        # LocalNet, DecMan, the treasury Decentralized Party, GovernanceRules, the charter
                              # (10 to 20 minutes the first time; idempotent; --dry-run prints every request)
scripts/localnet-env.sh       # writes the generated settings (parties, nodes, ledger URL) into .env
```

Open `.env` and set what only you know: `LLM_API_KEY`, `LLM_MODEL` (and `LLM_BASE_URL` for a provider other than OpenAI), `LOCALNET_DEMO_PASSWORD` (the password people type to enter the demo), `SESSION_SECRET` (`openssl rand -hex 32`) and `DATABASE_URL` if yours differs from `.env.example`. Then:

```sh
pnpm install && pnpm build
pnpm seed:localnet            # optional: the organization, the Mandate, four holders and June and July, tagged "Seeded"
export WEB_DIST_DIR=apps/web/build
node apps/backend/dist/index.js     # the backend serves the built web app on http://localhost:8787
```

Open http://localhost:8787, **Launch app**, enter the demo password and use the **Acting as** switcher (Treasurer, Approver 1 to 3, Holder A to D, Auditor). Without the seed, set the fund up from the app: it is the first act of [docs/demo-script.md](docs/demo-script.md). For development, `pnpm dev` runs the backend on :8787 and the web dev server on :5173 (it proxies `/api`).

Every step of the bring-up, what it prints, and a checklist of the parts that could not be run in the environment this was built in: [docs/verification.md](docs/verification.md). LocalNet details: [localnet/README.md](localnet/README.md).

## BitSafe: the treasury is a Decentralized Party

The treasury organization's party is a **Decentralized Party** created with BitSafe's Decentralization Manager, hosted on all three LocalNet nodes with a **hosting threshold of 2**: one node can be offline and the agent keeps running; below two, transactions wait and the app says so. The charter and every Mandate change are created by governed actions that need 2 of 3 node confirmations.

| Node | Operator                                       | Participant    | JSON Ledger API       | DecMan                |
| ---- | ---------------------------------------------- | -------------- | --------------------- | --------------------- |
| A    | Mithra Labs (app provider)                     | `app-provider` | http://localhost:3975 | http://localhost:8081 |
| B    | Ledgerline Fund Services (fund administrator)  | `app-user`     | http://localhost:2975 | http://localhost:8082 |
| C    | Canton super validator (synchronizer operator) | `sv`           | http://localhost:4975 | http://localhost:8083 |

Thresholds: hosting 2 of 3, namespace 2 of 3, governance confirmations 2 of 3. Settings, Infrastructure in the app shows the nodes, operators, threshold and live status ("Still running on 2 of 3 nodes"). The Daml Script tests `test_n8_*` prove a governed change cannot execute below its threshold; `scripts/bitsafe-demo.sh` runs the node-offline demonstration on a real LocalNet and writes a report to `docs/bitsafe-evidence/`. Full write-up, test results and remaining work: [docs/bitsafe.md](docs/bitsafe.md). The LocalNet run itself is still to be done on the owner's machine (see "What is not verified" below).

## MainNet payouts with Grofty

There is no MainNet node, so Mithra cannot host its Daml package or read the MainNet ledger. `NETWORK=mainnet` therefore means **MainNet payouts** (decision 11 in [docs/decisions.md](docs/decisions.md)):

| Runs on LocalNet (always)                                                                                                    | Runs on Canton MainNet (`NETWORK=mainnet`)                                |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Organization, policy, Mandate, units, proposals, approvals, decision records, audit requests and grants; the Mandate's rules | The CC transfers to the holders, signed by the treasurer in Grofty Wallet |

1. The Mandate's rules decide on the LocalNet ledger (`Mandate_AuthorizeExternalPayout` applies the same checks as `Mandate_AgentExecute`: cap, payees, amounts, one per cycle, approvals). Nothing moves yet.
2. **Holders connect Grofty** on their welcome page: the app asks the wallet to sign a short message, the server checks that the signing key owns the party id, and stores the pairing (the MainNet party the holder is paid to). Holders **turn on auto-receive** in Grofty (the page guides them, N5).
3. The treasurer opens the cycle and **Sign payouts in Grofty**: connect, a balance check (amount still to send plus the fee buffer, otherwise "Add funds"), then **Pay in Grofty** per holder. The browser calls `prepareExecuteAndWait({ receiver, amount, memo })` (single-party submission, version 2.0.4 or newer).
4. The server records each transfer on the ledger (`Payment_RecordExternal`, an attestation, since the ledger cannot see MainNet); a row says **Paid** only after that, with a link to the explorer.

Handled errors, each with its own message: wallet not installed or older than 2.0.4, locked or not connected (4100), declined (4001), approval expired after 3 minutes (-32603), a transfer the wallet executed but the server could not record (recorded again, never sent twice), balance too low. To run it: set `NETWORK=mainnet`, `MAINNET_EXPLORER_TX_URL` (with `{updateId}`) and optionally `MAINNET_SCAN_URL` on top of the LocalNet `.env`, use a browser with Grofty Wallet 2.0.4 or newer, and follow [docs/verification.md](docs/verification.md), "MainNet payouts with Grofty", with small amounts. That section also lists the nine things only a real Grofty can confirm. The badge reads "MainNet payouts · records on LocalNet" so nobody is misled about where the records are.

## Configuration

All configuration comes from environment variables; [.env.example](.env.example) lists every one with a one-line description, and the backend names every missing or invalid variable at startup. The main ones:

| Variable                                                                                      | What                                                                    |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `NETWORK`                                                                                     | `localnet`, or `mainnet` for MainNet payouts (records stay on LocalNet) |
| `DATABASE_URL`                                                                                | PostgreSQL for app data (sessions, chat, job state)                     |
| `SESSION_SECRET`                                                                              | signs the session cookie, at least 32 characters                        |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`                                                    | any OpenAI-compatible provider                                          |
| `LOCALNET_DEMO_PASSWORD`                                                                      | the password for the demo sign-in                                       |
| `LEDGER_JSON_API_URL`, `TREASURY_PARTY`, `AGENT_PARTY`, `OPERATOR_PARTY`, `ASSET_ADMIN_PARTY` | the ledger and its parties (written by `scripts/localnet-env.sh`)       |
| `HOLD_COUNTDOWN_SECONDS`                                                                      | the Hold countdown before an auto-execute payout (default 30)           |
| `DEMO_VIDEO_URL`                                                                              | optional: shows "Watch the 3-minute demo" on the landing page           |
| `MAINNET_EXPLORER_TX_URL`, `GROFTY_MIN_VERSION`, `MAINNET_SCAN_URL`                           | MainNet payouts only                                                    |

## Testing

```sh
pnpm install
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build   # lint, formatting, types, Vitest (backend, web, shared), build
scripts/daml.sh test                                                          # 65 Daml Script tests for L1 to L11, payments, audit, governance (dpm or Docker)
scripts/sandbox.sh start                                                      # a Canton sandbox with the Mithra DARs on :7575 (Docker)
cd apps/backend && npx vitest run --config vitest.integration.config.ts       # integration tests against the sandbox and PostgreSQL
pnpm e2e                                                                      # the happy path in a real browser
```

The integration tests need the sandbox and PostgreSQL users `mithra`/`mithra` with the databases listed in `.github/workflows/ci.yml`. `pnpm e2e` builds the web app if needed, starts the full-stack test server (the real app on the sandbox with a stub model, port chosen freely), walks [userflow.md](userflow.md) section 0 with a browser and checks eight screens with axe (no serious or critical violations): see [e2e/README.md](e2e/README.md). Accessibility results and the keyboard checklist: [docs/accessibility.md](docs/accessibility.md). Every requirement with the tests that prove it: [docs/traceability.md](docs/traceability.md). CI runs all of the above (`.github/workflows/ci.yml`).

## Demo

[docs/demo-script.md](docs/demo-script.md): setup, the clean August cycle, the flagged September cycle with two approvals, the audit, and the BitSafe segment, with what the viewer sees at each step.

## Documentation

| Document                                       | What                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------- |
| [details.md](details.md)                       | What Mithra is, who uses it, what it must never do                              |
| [userflow.md](userflow.md)                     | Screens, flows and the design system                                            |
| [specs.md](specs.md)                           | Requirements with IDs                                                           |
| [docs/traceability.md](docs/traceability.md)   | Every spec ID with its code, tests and status                                   |
| [docs/ledger-model.md](docs/ledger-model.md)   | The Daml model and authority flow                                               |
| [docs/bitsafe.md](docs/bitsafe.md)             | BitSafe evidence: nodes, operators, thresholds, tests, remaining work           |
| [docs/verification.md](docs/verification.md)   | What to check on your own machine, and the browser result                       |
| [docs/accessibility.md](docs/accessibility.md) | axe, Lighthouse and keyboard results                                            |
| [docs/demo-script.md](docs/demo-script.md)     | The demo story                                                                  |
| [docs/decisions.md](docs/decisions.md)         | Decisions and why                                                               |
| [docs/plan.md](docs/plan.md)                   | Milestones and status                                                           |
| [docs/research/](docs/research)                | Notes on Daml, the Ledger API, LocalNet, DecMan, Grofty, the wallet SDK, OpenAI |
| [localnet/README.md](localnet/README.md)       | The LocalNet setup                                                              |

## Limitations, and what is not verified

Honest list. Details and the owner's checklists are in [docs/verification.md](docs/verification.md).

- **Not run in the environment this was built in** (the LocalNet and DecMan images cannot be pulled there): `scripts/localnet-up.sh` against real images, the Decentralized Party on three nodes, taking a node offline, `scripts/bitsafe-demo.sh`, and the Canton error ids Mithra maps to "the treasury's nodes did not confirm". These were checked with `bash -n`, `shellcheck`, `--dry-run` and fake services. Everything else runs against a real Canton sandbox with a test token registry.
- **Not run with real services:** the OpenAI call (tested against a local stub that speaks the same protocol), and everything that needs a real Grofty Wallet and real MainNet CC (tested against fakes; nine guessed response shapes are listed for the owner).
- **MainNet is payouts only** (decision 11). Users other than the treasurer's payouts do not sign with their own Grofty party, which deviates from spec N6.
- **LocalNet test mode** signs for every demo party on the server behind one shared password. It is a demo, not an authentication system, and the "Acting as" list shows the demo party names to everyone (except on holder screens, which link to the launch page to switch instead).
- **One asset:** CC. The design goes through the token standard (CIP-56) so USDCx can follow, but it is not built.
- **Only the treasury is decentralized**; the other parties are ordinary parties on node A. Namespace changes are not demonstrated.
- **Videos and the submission** (S3, S4, S6) are the owner's.

## License

Mithra's own code has no license file (all rights reserved). The vendored DARs in `daml/dars` are Apache-2.0, from BitSafe's decentralization-manager and the Splice release (provenance and checksums in [daml/dars/README.md](daml/dars/README.md)).
