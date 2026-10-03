You are the implementer for fix list CR5 (CodeRabbit review of the web routes, test helpers, e2e setup and docs) in the Mithra repository at /home/user/Mithra, branch `ccr-a1ba735a-c2ycnx`.
Fix each item below, with a test for each code change. Do not commit or push. Nobody else edits the repository while you work. Do not add dependencies.

The review ran on a snapshot taken before fix lists CR1 to CR4. **Verify every item against the current code first**; if one no longer applies, say so in your report instead of changing code.

Context: `userflow.md`, `specs.md` (P4: the UI must not show "Paid" until the ledger confirms the transfer; N-rows for MainNet), `docs/decisions.md` (11: MainNet payouts signed in Grofty, records on LocalNet), `apps/web/src/routes/`, `apps/backend/src/mainnet/payouts.ts`, `apps/backend/src/cycle/rail.ts`, `daml/mithra/daml/Mithra/Payment.daml`. Services: Docker, PostgreSQL, the Canton sandbox at `localhost:7575` (`scripts/sandbox.sh start`; start `dockerd` and `pg_ctlcluster 16 main start` if needed).

## Fixes

1. **`routes/app/audit/[requestId]/+page.svelte`: the page keeps the previous request after a param change.** SvelteKit reuses the page component when only `requestId` changes (back/forward between two requests). `detail` loads only on mount, so `request`, `dropped`, `expiresIn` and the dialog state stay from the old request, and Grant could send the old record ids. Make a `requestId` change reset all request-specific state and load the new request, with no stale data usable while it loads. `routes/app/tx/[updateId]/+page.svelte` uses `{#key updateId}` around a component; a keyed block (move the body into a component under `$lib/components/audit/` if needed) or a reset-and-reload effect are both fine. Test: navigating from request A to B shows B, and the grant action targets B with B's records.
2. **`routes/app/cycles/[cycleId]/+page.svelte`: same problem for `cycleId`.** `cycle` reads `cycleId` inside `untrack` and loads only in `onMount`; approve/hold/release/cancel and the dialog, record, note, reason and failure state can act on the previous cycle. Apply the same fix as item 1 (and avoid a double load on first mount). Test: A to B shows B and the actions target B.
3. **Same file, `?record=1` effect:** it reruns when `cycle.data`, `dialog` or `record` changes, so after a failed record load, closing the panel (or a poll) reopens it. Make it one-shot. Test.
4. **`routes/app/settings/+page.svelte`:** `infra.load()` and its 10 s poll run on MainNet although the Infrastructure panel shows only on LocalNet. Load and poll only while `sessionStore.network === 'localnet'` (stop the poll when it is not). Test that no infrastructure request is made on MainNet.
5. **`routes/holder/+page.svelte` and `routes/holder/welcome/+page.svelte` `retry()`:** reset `retrying` in a `finally`.
6. **`routes/setup/mandate/+page.svelte`:** the post-seal `window.setTimeout` (refresh then navigate to `/app/overview`) is not cleared on unmount, so leaving the page early still redirects. Keep the timer id and clear it in the `onMount` cleanup. Test.
7. **`src/test/treasury/stub.ts`:** look up `METHOD path?query` before `METHOD path`, so a query-specific handler wins. Make sure existing tests still pass.
8. **Same file, fake `EventSource.emit`:** deliver only while `readyState === 1`; after `close()` nothing is dispatched. Fix any test that relied on emitting to a closed source (that would be a real bug in the test).
9. **MainNet `unknown` outcome is recorded as `Paid` (P4).** `GroftyMainnetRail.recordedStatus` (`cycle/rail.ts`) maps `unknown` to `Paid`, so a transfer whose result could not be read shows as settled. Change it so `unknown` is recorded as not yet confirmed (`AwaitingAcceptance`, with honest activity text, for example "Sent 15 CC to Holder A on MainNet (signed in Grofty); Mithra could not confirm it arrived. Check it in Grofty."). There is no MainNet node (decision 11), so give the treasurer a way to confirm it later: an `awaiting-acceptance` row with a known update id offers "Check again", which re-reads `grofty.transferOutcome` and records again; a record with the same update id and outcome `completed` on an `AwaitingAcceptance` payment must move it to `Paid` (CR3's idempotent "already recorded with this update id" shortcut must only apply when the recorded status already matches). Check `Payment_RecordExternal` in `Payment.daml` allows `AwaitingAcceptance` to `Paid` with the same update id; if it does not, use the least disruptive ledger change and add a Daml Script test. Update the cycle status derivation if needed (a cycle with an `AwaitingAcceptance` MainNet payment is `awaiting-acceptance`, not paid). Note the change in `docs/decisions.md`. Tests: backend (unknown records AwaitingAcceptance; a later completed record with the same id marks Paid; same id and same status stays idempotent) and web (Check again).
10. **`e2e/global-setup.ts`:** on the early-exit path call `stop(server)` and `log.end()` before throwing; on the timeout path also call `log.end()`. Keep the messages.
11. **Docs:**
    - `docs/briefs/M11.md`: the S5 and U4 table rows have two cells under a three-column header. Add the missing acceptance cell for each (S5: evidence document with test results, node and operator list, thresholds, remaining work and named technical owner; U4: the panel shows hosting nodes, operators, the 2-of-3 threshold and live status, including "Still running on 2 of 3 nodes" when one is offline). Match the other rows' wording.
    - `docs/research/wallet-sdk.md` line 30: escape the `|` in `{ contractId, templateId, expiresAt } | null` as `\|`.
    - `docs/research/grofty.md` around line 10: the snippet calls `grofty.connect()` on a value that can be `null`; add the null check (`if (!grofty) { /* show install link */ }`) as `apps/web/src/lib/wallet/grofty.ts` does.

Not to change (already handled, I will reply on the review): the e2e server already listens on `127.0.0.1`; `VIEW_SESSION_MS` defines a view session as opens within 10 minutes; the A9 scheduler path is covered by `test/integration/agent.test.ts` (500 ms interval) and the CR3 timer unit test; the "passwords" in docs are the local test database URLs.

## Acceptance checks you must run and pass
1. Root `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build`.
2. `scripts/daml.sh test`.
3. `cd apps/backend && npx vitest run --config vitest.integration.config.ts` against the sandbox.
4. `pnpm e2e` passes.

## When you finish, report
1. Files changed, by fix number.
2. Items that no longer applied, with the reason.
3. For fix 9: the design you chose, whether the Daml model changed, and how the cycle status behaves.
4. Exact commands you ran and their output (summaries).
5. Each acceptance check: pass or fail, with evidence.
6. Anything you could not fix and why.
