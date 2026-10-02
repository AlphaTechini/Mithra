You are the implementer for fix list CR3 (CodeRabbit review of the backend features: agent tools, audit, holders, MainNet, routes) in the Mithra repository at /home/user/Mithra, branch `ccr-a1ba735a-c2ycnx`.
Fix each item below, with a test for each. Do not commit or push. Nobody else edits the repository while you work. Do not add dependencies.

The review ran on a snapshot taken before fix lists CR1 and CR2 (`docs/briefs/CR1.md`, `docs/briefs/CR2.md`). **Verify every item against the current code first**; if one no longer applies, say so in your report instead of changing code. (CodeRabbit's tenth finding, parallel integration suites resetting a shared database, was handled in CR2 fix 17.)

Context: `specs.md` (A3, A6: the model never chooses an amount), `docs/ledger-model.md`, `docs/decisions.md`, `apps/backend/src/wiring/backend.ts`. Services: Docker, PostgreSQL, the Canton sandbox at `localhost:7575` (`scripts/sandbox.sh start` if it is not running; start `dockerd` and `pg_ctlcluster 16 main start` if needed).

## Fixes

1. **`agent/tools/createCycle.ts` `amountsWritten` accepts numbers that are not amounts** (A3/A6). The guard that stops the model from choosing a total takes every number in the treasurer's text: "September 2026" gives 2026, "Q3" gives 3, "2 of 3 approvals" gives 2 and 3, "2026-09" gives 2026 and 09. A model passing `total: "2026"` for "Distribute for September 2026" would pass the guard. Count only numbers written as amounts: exclude years after a month name, ISO dates and cycle ids (`YYYY-MM`, `YYYY-MM-DD`), `Qn`, `n of m`, ordinals and percentages, and keep amounts such as `300`, `1,200`, `1.2k`, `300 CC`. Apply the same matcher wherever the agent checks that an amount was written (search for other callers, for example `runCycleNow.ts`). Tests: "Distribute for September 2026" and "Run Q3" yield no amount (the tool asks for the total), "Distribute 300 CC for August 2026." yields exactly 300, "1,200 CC for September" yields 1200.

2. **`agent/policyFields.ts` `resolveMandateChange` compares decimals as JSON strings**, so the sealed cap `5000.0000000000` and the model's `"5000"` count as a change ("5,000 CC to 5,000 CC"). Compare `cap`, `fixedAmount`, `deviationPct`, `unitChangePct`, `feeBuffer` by decimal value; keep the JSON comparison for other fields. Test with the 10-place ledger form.

3. **`audit/evidence.ts` `byLabel`** sorts "Holder AA" before "Holder B". Compare label length first, then the string. Test with more than 26 holders.

4. **`audit/expiry.test.ts`**: the timer test passes even if the interval path is broken, because the grant is already expired at startup and the first immediate check closes it. Start with an unexpired grant and an injected clock, advance the clock past expiry after startup, and assert a timer tick closes it (and nothing was submitted before).

5. **`holders/autoReceive.ts` `invalidate`** does not discard a lookup already in flight, so that lookup can be shared after invalidation and write the old answer into the cache for the full TTL. Keep a per-holder generation: bump it in `invalidate`, drop the in-flight entry, and cache a result only if its generation is still current. Test the sequence lookup starts, invalidate, get, old lookup resolves.

6. **`mainnet/payouts.ts`**: after `paymentRecordExternal` succeeds on the ledger, a `store.setTxRef` failure returns an error to the treasurer, and a retry with the same update id targets the archived payment contract. Make the record step retry-safe: a retry for a payment that the ledger already recorded with that update id returns success (and repairs the tx ref), and a bookkeeping failure after the ledger write is logged, not reported as a failed recording. Test.

7. **`routes/showcase.ts`**: the public route caches only resolved values, so concurrent requests after expiry each rebuild, and a failed build is never cached. Cache the in-flight promise; on rejection clear the entry only if it is still the current one. Test concurrent requests share one build and a failure lets the next request retry.

8. **`routes/treasury/format.ts` `describeSchedule`** maps any numeric weekday with `% 7`, so `0 9 * * 8` reads "Weekly on Monday". Return the raw cron text for weekdays outside 0 to 7. Test.

9. **`routes/treasury/index.ts` `/api/overview`**: a rejection from `cycles.listCycles()` fails the whole request while the other reads in the same `Promise.all` degrade. Log a warning and use an empty list. Test.

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
