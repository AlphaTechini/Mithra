You are the implementer for fix list FX1 in the Mithra repository at /home/user/Mithra. The orchestrator walked through the integrated product in a browser (full-stack server against the Canton sandbox) and found the issues below. Fix each one, with a test for each. Do not commit or push. Nobody else is editing the repository while you work. Do not add npm dependencies.

Context you may need: `userflow.md` (sections 3, 6, 8, 9, 11), `docs/ledger-model.md`, the shared API contract in `packages/shared/src/api/`, backend wiring in `apps/backend/src/wiring/backend.ts`, the full-stack test server `apps/backend/test/e2e/server.ts` and `apps/backend/test/integration/fullstack.test.ts`.

## Fixes

1. **Auditor has no way in (dead end).** A signed-in party with no role (for example the LocalNet demo party "Auditor" before any request) lands on `/start`, which only offers "Set up a treasury" and "I was invited", and the backend answers `403 forbidden_role` to `POST /api/audit/scope/draft`. Userflow 11.1: "Auditor connects and lands on the Audit workspace." Fix:
   - Backend: any signed-in party that is not the treasurer, an approver or a holder of this fund may use `POST /api/audit/scope/draft`, `POST /api/audit/requests` and `GET /api/audit/requests` (own requests only) as a prospective auditor. Everything else about auditor access stays as is (evidence only through their own grant). Integration test.
   - Frontend: `/start` gets a third option "I'm an auditor" ("Ask this fund for access to specific records.") linking to `/auditor`; the auditor layout lets in parties whose `primaryRole` is `auditor` or `null`. `homeFor(null)` stays `/start`.
   - LocalNet role switcher: when a demo party's display name is "Auditor" and it has no role yet, route to `/auditor` (keep this as a small, commented LocalNet convenience in `lib/routing.ts`).
2. **Issue units offers no demo holders.** On a fresh setup, the Issue units dialog (`apps/web/src/lib/components/treasury/IssueUnitsDialog.svelte`) lists only existing holders plus "Another party id…", so the treasurer must paste party ids. On LocalNet, list the demo parties from `/api/session/demo-parties` that are not the treasurer or an approver (by their resolved roles), with existing holders first; MainNet unchanged. Component test.
3. **Organization approver picker**: on LocalNet preselect nothing, but order demo parties whose display name starts with "Approver" first and show holders and the auditor under a "Other demo parties" sub-heading. Component test.
4. **Agent misreports an existing cycle.** Asking "Distribute 300 CC for September." again after September was paid replies "Within your mandate. It runs automatically after the hold countdown." The `create_cycle` and `run_cycle_now` tools must read the cycle's actual status after `run` returns and word the card and the reply from it: already paid ("September 2026 was already paid automatically on <date>. Nothing new was created."), awaiting approval, held, needs funds, failed (with the error). Tests with the fakes.
5. **Agent panel stays open after following an action card link.** Close the panel when an action card or transcript link navigates. Component test.
6. **Memo source shows a raw value.** On the cycle page and the decision record panel, show `memoSource` as words: `ai` → "Written by the AI reviewer", `template` → "Written from the checks", `ai-unavailable` → "AI review unavailable; written from the checks". Test.
7. **Template memo grammar.** "1 checks flagged" → singular/plural correct everywhere in `apps/backend/src/cycle/memo.ts` (and any other count phrases in check or timeline text: "1 holder", "1 passed"). Unit tests.
8. **Seeded activity entries are not tagged.** Activity rows the cycle engine records for a run with `seeded: true` must carry `seeded: true` (U8). Test.
9. **SSE roles are fixed at connect.** `apps/backend/src/routes/events.ts` resolves the viewer's roles once; a treasurer who opened the stream before creating the organization never receives team events. Re-resolve roles at most every 15 seconds per connection (lazily, when an event arrives and the cached roles are older than 15 s). Test.
10. **Seed data for the demo story.** In `scripts/seed/steps.ts`: seed **June 2026 (400 CC) and July 2026 (420 CC)** as seeded history instead of July and August, so the live demo can run August (clean, 300 CC) and September (flagged) on the day; on LocalNet also create auto-receive preapprovals for Holders A to C (through `Funding.createPreapproval`, skipping a holder whose registry lookup already reports `direct`) so that only Holder D shows the pending-acceptance path. Update the seed's printed lines and `--sandbox` mode (the test server already gives A to C preapprovals). Update `docs/verification.md` (seeding section) accordingly. Run `--sandbox` twice to prove idempotency.
11. **Test sealer activity.** The test-only direct sealer (`apps/backend/test/integration/cycleHelpers.ts` or wherever M4 put it) should record `mandate.seal-requested` and `mandate.sealed` activity entries with the same text as the DecMan sealer, so the full-stack server behaves like LocalNet.
12. **Launch `next` with the role switcher.** `RoleSwitcher` gets an optional `next` prop used instead of `homeFor(role)` after a switch; `/launch` passes its validated `next`. Test.
13. **Audit chips.** Add `StatusChip` kinds `waiting-treasurer` ("Waiting for the treasurer") and `withdrawn` ("Request withdrawn"); make `lib/components/audit/AuditStatus.svelte` use them instead of its own chips. Update the StatusChip test.
14. **Demo story in docs.** Add `docs/demo-script.md`: the main demo following `details.md` section 10 with the August clean cycle and the September flagged cycle (Holder C's units jump just before the record date; total 1,200 CC against a ~400 CC average; Approver 1 and 2 approve), the audit request, and the BitSafe segment placeholder (a later milestone fills it); exact clicks and prompts, and what the viewer sees at each step. Keep it under two pages.

## Acceptance checks you must run and pass
1. Root `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build`.
2. `cd apps/backend && npx vitest run --config vitest.integration.config.ts` (all integration files) passes against the sandbox at `localhost:7575` (use databases as the existing tests do; the default ones exist).
3. `scripts/daml.sh test` still passes (you should not need to touch Daml).
4. Each fix has a test; list them by number in your report.

## When you finish, report
1. Files changed, by fix number.
2. Exact commands you ran and their output.
3. Each acceptance check: pass or fail, with evidence.
4. Anything you could not fix and why.
