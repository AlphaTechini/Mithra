You are the implementer for fix list CR4 (CodeRabbit review of the web app's lib and components, plus security findings from the review summaries) in the Mithra repository at /home/user/Mithra, branch `ccr-a1ba735a-c2ycnx`.
Fix each item below, with a test for each. Do not commit or push. Nobody else edits the repository while you work. Do not add dependencies.

The review ran on a snapshot taken before fix lists CR1 to CR3. **Verify every item against the current code first**; if one no longer applies, say so in your report instead of changing code.

Context: `userflow.md`, `specs.md` (U-rows for the screens, N-rows for MainNet), `docs/decisions.md` (11: MainNet payouts signed in Grofty), `apps/web/src/lib/`. Services: Docker, PostgreSQL, the Canton sandbox at `localhost:7575` (`scripts/sandbox.sh start`; start `dockerd` and `pg_ctlcluster 16 main start` if needed).

## Fixes (web, `apps/web/src/lib/`)

1. **`components/treasury/SignPayouts.svelte`: a reload during a MainNet payout can let the treasurer pay twice.** After `grofty.transfer` resolves, the code awaits `transferOutcome` and the record call, and only calls `remember(...)` if recording fails. Remember `{ updateId, outcome: 'unknown' }` immediately after `transfer` resolves, update it with the real outcome, then record. Make sure a remembered entry stops the row from offering "Pay in Grofty" again and resumes recording instead. Test.
2. **`stores/agent.svelte.ts` `retry()`** after a failed send reloads the conversation and loses the prompt. Keep the failed prompt; `retry()` resends it when present, otherwise reloads; `reset()` clears it. Test.
3. **`stores/agent.svelte.ts` `onAgentEvent`**: an action for an unknown message goes into `liveActions` even when no send is running, leaving an orphan card. Add it only while `state.busy`. Test.
4. **`components/audit/NewRequest.svelte`**: if the question changes while `draftScope` is pending, the old answer is shown for the new question and can be submitted. Capture the question before the await; ignore the response if it no longer matches. Test.
5. **`components/holder/TxDetailView.svelte`**: `updateId` is read only on mount and a failed retry keeps the old `tx`. Reload when `updateId` changes, reset `tx`/error before each fetch, and apply only the latest response. Test.
6. **`components/landing/ShowcaseSeal.svelte`**: (a) a failed request shows "nothing has been approved on this ledger yet"; show accurate text for a failed request and keep that sentence for a successful empty answer; (b) honour `prefers-reduced-motion` changes after mount (listen for `change`, stop the animation and show the final state, remove the listener on unmount). Tests.
7. **`components/audit/AuditorRequestPanel.svelte`**: after a 410 for a request still marked `granted` (access ended early), it shows the scheduled `expiresAt` as "Access ended". Show the ended status without that date until the server supplies `closedAt`. Test.
8. **`components/treasury/RunCycleDialog.svelte`**: the total accepts 0 and negatives. Reject them client-side like `AddFundsDialog` ("Enter the total as a number above zero, like 1200 or 1200.50."). Test.
9. **`policyForm.ts` `POSITIVE_DECIMAL`** (and the same check in `AddFundsDialog.svelte`) accepts a leading minus. Reject it so the field shows its own error. Test.
10. **`stores/session.svelte.ts`**: after a successful `signIn` or `switchParty`, set `status` to `'ready'` and clear `error` when `config` is loaded, so `SessionGate` does not stay on an earlier error or skeleton. Test.
11. **`wallet/grofty.ts`** balance normalisation turns numbers into strings with `String(value)` (`1e-7`, precision loss). Accept amounts only as decimal strings; reject numbers (null). Test.
12. **`components/Amount.test.ts`**: the "falls back to CC" test never awaits the rerender or asserts the symbol. Fix the test.
13. **`components/holder/TxLink.svelte`** (security): an external link's `href` is bound directly, so a `javascript:` URL could run script. Render an anchor only for `http:`/`https:` external URLs (and validate the shared schema field if that is the right place). Test.
14. **`components/AppLink.svelte`** (security): a protocol-relative value like `//evil.example/x` survives as a cross-origin URL. Normalise to a single leading `/` before resolving. Test.
15. **`stores/live.svelte.ts`** (low): `close()` resets `connectedAs` but not `hadOpen`, so the next open after a party switch is treated as a reconnect and fires every reconnect handler. Reset it. Test.

## Fixes (backend, from the #4 review summary)

16. **`apps/backend/src/audit/expiry.ts`** (security): the `grant.closed` activity entry written on expiry has no `audience`, unlike the audit service's entries (`audience: { roles: ['treasurer'] }`). Check what `ActivityLog.record` does without an audience; if it is visible beyond the treasurer, pass the same treasurer-only audience. Test.
17. **`apps/backend/src/routes/agent/index.ts`** (security): `POST /api/policy/draft` and `POST /api/audit/scope/draft` call the LLM without the per-party rate limit that `POST /api/agent/messages` has (the scope route is open to any signed-in party). Add a per-party limiter to both (for example 10 per minute) returning 429 `too_many_requests`. Test.

## Acceptance checks you must run and pass
1. Root `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build`.
2. `scripts/daml.sh test`.
3. `cd apps/backend && npx vitest run --config vitest.integration.config.ts` against the sandbox.
4. `pnpm e2e` passes.

## When you finish, report
1. Files changed, by fix number.
2. Items that no longer applied, with the reason.
3. Exact commands you ran and their output (summaries).
4. Each acceptance check: pass or fail, with evidence.
5. Anything you could not fix and why.
