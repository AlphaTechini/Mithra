# Mithra build plan

Deadline: October 9, 2026, 23:59 UTC. Target: happy path working by October 7.
Orchestrator plans, briefs, reviews and integrates; a Sonnet 5.5 implementer writes the code from each brief (`prompts/kickoff.md`).

## Environment (checked 2026-10-01)

| Capability | Status in this cloud session | Consequence |
|---|---|---|
| Node 22, pnpm 10 | yes | |
| Docker daemon | yes (started manually) | |
| Docker Hub | yes | Daml SDK via `digitalasset/daml-sdk:3.4.0-rc2` for build and Script tests |
| `dpm` installer (`get.digitalasset.com`, `europe-docker.pkg.dev`) | blocked | owner uses `dpm` 3.4.11; `scripts/daml.sh` falls back to Docker |
| Splice LocalNet images (ghcr blobs) | blocked | LocalNet runtime steps verified on the owner's machine |
| DecMan image (ECR blobs) | blocked | same |
| api.openai.com | blocked | LLM tested with a local stub server; live check on owner's machine |
| PostgreSQL 16 | installed | backend integration tests run here |
| GitHub source via git | yes | research from source |

## Milestones

| ID | Milestone | Spec IDs | Depends on | Parallel with | Status |
|---|---|---|---|---|---|
| M0 | Monorepo scaffold | T1–T5, N1 | — | M1 | pending |
| M1 | Daml model + Script tests | L1–L11, N8 (Daml part) | — | M0 | pending |
| M2 | LocalNet compose + DecMan + bootstrap scripts | N2, N7, T4 | M1 | M3 | pending |
| M3 | Backend foundation (config, ledger module, auth, DB, roles, seeding) | N1–N3, T2, T5 | M0, M1 | M2, M6 | pending |
| M4 | Cycle engine (snapshot, pro-rata, checks, decision records, payments) | L1–L4, L10, A3, A4, P1, P2, P4, P5 | M3 | M6 | pending |
| M5 | Agent, scheduler, grant expiry, SSE | A1–A12 | M4 | M6 (late) | pending |
| M6 | Frontend foundation | U2–U5, U9, N3 | M0 | M1, M3, M4 | pending |
| M7 | Treasurer screens | U1, U6, userflow 4, 5, 7, 8, 9, 12 | M5, M6 | — | pending |
| M8 | Approver and holder screens | L5, L7, U7, P2, userflow 6, 10 | M7 | M9 backend | pending |
| M9 | Audit flow | L8, L9, A8, A9, userflow 11 | M5, M6 | M10 backend | pending |
| M10 | MainNet with Grofty | N4–N6, P3 | M8 | M9 frontend | pending |
| M11 | BitSafe evidence | N8, S5 | M2, M5 | M12 | pending |
| M12 | Landing, Playwright, accessibility, README, traceability | U1, U5, S1, S2 | all | — | pending |

File ownership for parallel work: M0 owns the repo root, `apps/`, `packages/`; M1 owns `daml/` and `scripts/daml.sh`; M2 owns `localnet/` and `scripts/localnet*`; M3/M4/M5 own `apps/backend` and `packages/shared`; M6–M9 frontend parts own `apps/web`.

## Schedule

| Date | Work |
|---|---|
| Oct 1 | Step 0 research; M0 and M1 in parallel |
| Oct 2 | M2, M3; M6 in parallel |
| Oct 3 | M4, M5 |
| Oct 4 | M7, M8 |
| Oct 5 | M9, M10 |
| Oct 6 | M11, M12 |
| Oct 7 | Final review, owner verification on LocalNet and MainNet |
| Oct 8–9 | Videos (owner), fixes |

## Priority if time runs short

Ledger guarantees, cycle engine, agent with guardrails, treasurer and approver happy path, holder isolation, audit flow, Grofty on MainNet, BitSafe evidence, landing page polish. Should-haves (seeding labels, Infrastructure panel live status) go before any MUST. The owner is told before anything is dropped.
