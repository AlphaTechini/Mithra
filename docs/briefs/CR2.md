You are the implementer for fix list CR2 (CodeRabbit review of the backend core: ledger client, cycle engine, governance, scheduler, infrastructure) in the Mithra repository at /home/user/Mithra, branch `ccr-a1ba735a-c2ycnx`.
Fix each item below, with a test for each. Do not commit or push. Nobody else edits the repository while you work. Do not add dependencies (Node 22's global `WebSocket` and `fetch` are available).

The review ran on a snapshot taken before fix list CR1 (`docs/briefs/CR1.md`, commit f50571a) changed `cycle/engine.ts`, `cycle/period.ts` and `ledger/mithra/commands.ts`. **Verify every item against the current code first**; if one no longer applies, say so in your report instead of changing code.

Context: `docs/ledger-model.md`, `docs/decisions.md`, `docs/research/ledger-api.md` (JSON Ledger API v2, including the WebSocket streams in the asyncapi notes), `apps/backend/src/wiring/backend.ts`. Services: Docker, PostgreSQL, the Canton sandbox at `localhost:7575` (`scripts/sandbox.sh start` if it is not running; start `dockerd` and `pg_ctlcluster 16 main start` if needed).

## Fixes

1. **`auth/plugin.ts` session lookup on every request.** The `onRequest` hook looks up the session for static assets and `/api/health` too. Skip the cookie check and `SessionService.find` for paths outside `/api/` and for `/api/health`. Test: an asset request and `/api/health` with a session cookie do not call `find`; an API route still gets its session.

2. **`cycle/engine.ts`: a bookkeeping failure after the ledger confirmed a payout marks the cycle `failed`.** `afterRail` runs inside the same `try` as `this.rail.run`, so a DB error after a confirmed payout goes down the payment-failure path ("The payments … did not go through") although the money moved. Separate the two: a failure after the rail returns must never report the payout as failed; leave the row in `executing` and make sure `recoverStale`/`advance` reconcile it from the ledger outcome (extend `syncFromLedger` to `executing` rows if it only handles `proposed`). Test with a store that throws once after the rail succeeds: the cycle ends paid after the next advance, and no "did not go through" activity is written.

3. **`cycle/period.ts` `recordDateFor` uses the UTC month end.** For `day_before_payment` the search for the payment run starts at `<lastDay>T23:59:59.999Z`, which is the month end only in UTC. Start before the earliest possible local midnight of the 1st of the next month (UTC+14) and skip runs whose local date (in `schedule.tz`) is still inside the cycle month; keep CR1's clamp into the cycle month. Tests: `0 0 1 * *` in `Asia/Tokyo` and `0 23 L * *` in `America/Los_Angeles`.

4. **`cycle/reconcile.ts` accepted payments.** After `paymentMarkAccepted` is submitted, a failure in `store.setTxRef` or `activity.record` rejects the whole pass, loses the payment's link for good and skips the remaining payments. Catch and log bookkeeping failures per payment and continue. Test.

5. **`cycle/reconcile.ts` `sealsAdvanced`** lists seals whose `advance` failed. Push the id only when `advance` succeeded. Test.

6. **`cycle/store.ts` timeline events are not scoped to the treasury.** `agent_events` has no treasury column; `addTimeline`/`timeline` use only `cycleId`, so two treasuries in one database (the integration tests do this) share timeline rows. Add the treasury column with a new Drizzle migration (generate it with the repo's drizzle-kit config, do not hand-write the snapshot), set it on insert from the store's `orgTreasury`, and filter by both on read. Test.

7. **`funding/index.ts` `fundTreasury` retries tap again** after a partial failure. Before tapping, reuse what the operator already holds (skip the tap when the operator's balance covers the amount) and accept any pending transfer instruction to the treasury first. Fix the error text that tells the user to "add funds again" if it is no longer accurate. Test.

8. **`governance/decman.ts` two concurrent seals.** `start` does not check for a pending seal, so two starts capture the same base version and `advance` can mark the second `sealed` on the first one's version change. Reject `start` with HTTP 409 `seal_in_progress` ("A Mandate change is already waiting for the nodes. Wait for it to finish, then try again.") while a seal is pending, serialised so concurrent starts cannot both pass (a mutex or a DB constraint), and when advancing, mark a row `sealed` only if the new Mandate is the one this request produced (match `summaryFingerprint`). Check the test sealer used by the full-stack server behaves the same. Test.

9. **`http/rateLimit.ts`**: sweep idle keys at most once per `windowMs` when the map is over 10,000 keys (track `lastSweep`). Test.

10. **Credentials over cleartext and redirects** (`ledger/client.ts`, `ledger/auth.ts`, `config/env.ts`). Set `redirect: 'manual'` on the ledger fetch and the OIDC token fetch, and treat a 3xx as a non-retryable error. Require `https:` for `LEDGER_OIDC_TOKEN_URL` and for the ledger URL (including URLs passed to `atUrl`) whenever a token or client secret is sent, except for loopback hosts (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`), which is how every LocalNet URL looks (`localnet/nodes.env`, `.env.example`). Config errors must say what to change. Tests.

11. **`ledger/client.ts` `activeContracts` hits the participant's list limit.** `POST /v2/state/active-contracts` returns HTTP 413 when the result is larger than the participant's `http-list-max-elements-limit`. Add a WebSocket ACS read (the JSON API's `/v2/state/active-contracts` WebSocket stream; auth via the `jwt.token.<token>` and `daml.ws.auth` subprotocols when a token is present) and use it when the HTTP read returns 413 (or always, if you show it is as reliable on the sandbox). Verify the WebSocket read against the running sandbox in an integration test; unit-test the 413 fallback with a fake. Record what you verified in `docs/research/ledger-api.md` and `docs/verification.md`, and add the participant setting to `localnet/README.md` as an operator note.

12. **`ledger/mithra/queries.ts` `newestFirst` compares ISO strings**, so `…24.254Z` sorts after `…24.254844Z`. Sort by the ledger offset when the contract carries it (carry `offset` from `ActiveContract` into `Contract` if it is not there), else by parsed instant, with `contractId` as the tiebreak. Test with both timestamp forms.

13. **`llm/client.ts`** silently drops tool calls whose `type` is not `function`. Throw `LlmInvalidOutputError` naming the type. Test.

14. **`parties/names.ts`** concurrent `name()` calls on a stale cache each start their own query. Share one in-flight refresh promise. Test.

15. **`scheduler/index.ts` a failed cycle blocks the schedule for good.** `hasRun` and the in-memory `started` set block every later attempt even when the run failed, was rejected or cancelled. Make the check status-aware (active or executed runs block; `failed`, `rejected`, `cancelled` allow a retry) and drop the permanent `started` block. Test a retry with the same scheduler instance.

16. **`scheduler/index.ts` `refresh()`** checks `stopped` only before awaiting the Mandate read, so a refresh in flight during `stop()` can create a cron job after shutdown. Check `stopped` again after the await. Test.

## Acceptance checks you must run and pass
1. Root `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build`.
2. `scripts/daml.sh test`.
3. `cd apps/backend && npx vitest run --config vitest.integration.config.ts` against the sandbox (including the new WebSocket ACS test).
4. `pnpm e2e` passes.

## When you finish, report
1. Files changed, by fix number.
2. Items that no longer applied after CR1, with the reason.
3. For fix 11: what you verified against the sandbox, and whether the WebSocket read is used always or only after a 413.
4. Exact commands you ran and their output (summaries).
5. Each acceptance check: pass or fail, with evidence.
6. Anything you could not fix and why.
