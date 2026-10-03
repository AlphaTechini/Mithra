You are the implementer for fix list CR1 (CodeRabbit review of the Daml model, shared package and scripts) in the Mithra repository at /home/user/Mithra, branch `ccr-a1ba735a-c2ycnx`.
Fix each item below, with a test where one is named. Do not commit or push. Nobody else edits the repository while you work. Do not add dependencies.

Context: `docs/ledger-model.md`, `docs/decisions.md`, `specs.md` (L1 to L11), `daml/mithra/daml/Mithra/{Mandate,Proposal,Types,Org}.daml`, the Daml Script tests in `daml/mithra-tests/`, the backend's ledger commands (`apps/backend/src/ledger/mithra/commands.ts`) and cycle engine (`apps/backend/src/cycle/engine.ts`, `period.ts`). Services you need are running: Docker (for `scripts/daml.sh`), PostgreSQL, the Canton sandbox at `localhost:7575` (`scripts/sandbox.sh start` if it is not).

## Fixes

1. **`Proposal_MarkExecuted` is reachable by the treasury alone** (`Proposal.daml`). Its controller is only `treasury`, so the treasury can exercise it directly and skip the cap, the approval threshold and the one-payout-per-cycle rule (L1, L3, L4) that `executeDistribution` and `Mandate_RecordExternalPayout`-style paths check. Make it require both `treasury` and `treasurer` (both are signatories of the Mandate, so every Mandate execution path still has that authority; check each caller: `Mandate_AgentExecute`, `Mandate_TreasuryExecute`, the MainNet/external payout choice). Daml Script test: `submit treasury` alone exercising `Proposal_MarkExecuted` on a `NeedsApproval` proposal fails; the existing execution tests still pass.

2. **`Mandate_Propose` trusts the agent's `cycleId` and `recordDate`** (`Mandate.daml`). The agent can invent `"2026-09-b"` for a second cap-sized payout in the same period, or pick any record date. Enforce on the ledger:
   - `cycleId` is the canonical `YYYY-MM` of the cycle (write a small pure helper and unit-test it in Daml Script);
   - the record date follows `terms.recordDateRule`: for `last_day_of_previous_month` (meaning the last day of the month before the payment, which is the cycle's own month; see `recordDateFor` in `apps/backend/src/cycle/period.ts`) the record date must be the last day of the `cycleId` month; for `day_before_payment` it must fall inside the `cycleId` month;
   - the record date is not after the ledger's current UTC date (`toDateUTC <$> getTime`).
   Make sure the backend always sends values that pass (read `engine.ts` and `period.ts`), and update Daml tests that use other ids or rely on 1970 ledger time (use `setTime` in the test setup where needed). Tests: a non-canonical cycle id fails, a record date that breaks the rule fails, a future record date fails, the normal path passes.

3. **`(cycleId, attempt)` is not unique**, so two `DecisionRecord`s can share `recordId` `decision/<cycle>/<n>` and an audit grant scoped by record id could show the wrong one. Enforce uniqueness on the ledger with the least disruptive design (for example: the Mandate keeps the last attempt per cycle and `Mandate_Propose` requires `attempt` to be exactly one more, which means making it consuming and returning the new Mandate cid; or another design you justify). Update the backend command builder and the engine for any changed choice result, and keep the `recordId` format. Daml Script test: proposing the same `(cycleId, attempt)` twice fails; a retry with the next attempt succeeds. Integration tests must still pass.

4. **Negative amounts at the API boundary** (`packages/shared/src/api/treasury.ts`): add a non-negative decimal schema built on `DecimalString` and use it for `cap`, `fixedAmount`, `deviationPct`, `unitChangePct`, `feeBuffer` in `PolicyFieldsSchema` and `total` in `RunCycleRequestSchema`. Unit test in `packages/shared`.

5. **`scripts/localnet-up.sh` `on_exit`** calls `dry_cleanup` on every run; guard it with `if is_dry; then dry_cleanup; fi` (as `scripts/bitsafe-demo.sh` does).

6. **`scripts/localnet-up.sh` treasury step**: on the "party already exists" path also call `ledger_grant_rights a readAs "$existing"` (idempotent) so a rerun completes an interrupted grant. Check the dry-run (`scripts/localnet-up.sh --dry-run`) still works and `shellcheck -x` / `bash -n` are clean.

7. **`scripts/seed/steps.ts` cycles step**: skip only cycles whose status is in `EXECUTED`; a cycle in a `STUCK` status other than `failed` throws the `SeedError` that the polling code already uses; an in-progress cycle (countdown, proposed, executing) is polled and advanced to completion without starting a new run; a new run starts only when there is no cycle or it `failed`. Run `--sandbox` mode twice (see `docs/verification.md`) to show it is still idempotent.

8. **Root `typecheck`** (`package.json`): also run `tsc -p scripts/tsconfig.json`; fix any type errors that appear.

9. **CI** (`.github/workflows/ci.yml`): add `pnpm format:check` next to `pnpm lint`.

10. **`daml/dars/README.md`**: `scripts/localnet-bootstrap.sh` does not exist. Say what actually happens: `scripts/localnet-up.sh` uploads the governance and Mithra DARs; the token standard DARs ship with Splice LocalNet itself. Verify against `scripts/localnet-up.sh` before writing.

11. **Wording only**: the rule name `last_day_of_previous_month` reads as "the month before the cycle". Add a one-line comment at its definition in `Types.daml` (and in `period.ts` if the existing comment is not clear) saying it is the last day of the month before the payment date, that is the cycle's own month.

## Acceptance checks you must run and pass
1. Root `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build`.
2. `scripts/daml.sh test` (all Daml Script tests, including the new ones).
3. `cd apps/backend && npx vitest run --config vitest.integration.config.ts` against the sandbox.
4. `pnpm e2e` passes.
5. `bash -n` and `shellcheck -x` on the changed scripts; `scripts/localnet-up.sh --dry-run` exits 0.

## When you finish, report
1. Files changed, by fix number.
2. The design you chose for fix 3 and why.
3. Exact commands you ran and their output (summaries).
4. Each acceptance check: pass or fail, with evidence.
5. Anything you could not fix and why.
