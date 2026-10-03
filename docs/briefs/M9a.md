You are the implementer for milestone M9a: Audit flow backend, in the Mithra repository at /home/user/Mithra.
Write all code and tests for this milestone. Work only in `apps/backend/src/audit/service.ts`, `apps/backend/src/audit/catalog.ts`, `apps/backend/src/audit/evidence.ts`, `apps/backend/src/audit/*.test.ts` for those files, `apps/backend/src/routes/audit/`, and `apps/backend/test/integration/audit.test.ts` (+ a helpers file next to it). `src/audit/scope.ts` and `src/audit/expiry.ts` exist (M5): you may import them, not change them. A parallel implementer is wiring `app.ts`/`index.ts` and other backend code; another builds the audit screens in `apps/web`. **Never touch anything else.** Do not change the DB schema (use `activity_log` for view sessions). Do not add npm dependencies.

## Goal
An auditor asks a plain-English question, the agent proposes the smallest set of records that answers it with a reason per record, the auditor refines and requests access, the treasurer reviews exactly the records that would be shared side by side with the question and grants for 24 hours, 7 days or 30 days (or denies), the auditor opens a read-only evidence room built only from their own `SharedRecord` contracts, every view is logged, and at expiry the grant closes and the records disappear from the auditor's view.

## Context
- **Read `userflow.md` section 11 and `details.md` sections 5, 6 (audit request, access grant, activity log) and 7 (drafts audit scopes).**
- Ledger model: `docs/ledger-model.md` (Audit section) and `daml/mithra/daml/Mithra/Audit.daml`, `Org.daml` (`Org_GrantAccess`, `Org_DenyAccess`), `Decision.daml`. Backend ledger module: `src/ledger/` (`MithraReader`: `auditRequests()`, `grants()`, `sharedRecords(auditor)`, `closed()`, `denied()`, `decisionRecords()`, `outcomes()`; `reader.as([party])`; command builders for `AuditRequest` create, `orgGrantAccess`, `orgDenyAccess`, `accessGrantRevoke`, `auditRequestWithdraw`; `EvidenceRef` variants `RefDecision`/`RefOutcome` verified in M3 integration tests).
- Shared modules: `src/events/bus.ts` (publish `audit` events to the treasurer and the request's auditor only), `src/activity/log.ts`, `src/parties/names.ts`, `src/auth/roles.ts` (`requireRole`), `src/http/errors.ts`, the `parse` helper.
- Scope drafting (A8) exists: `src/audit/scope.ts` (`createScopeDrafter({ llm, catalog })` / `draftAuditScope(question, catalog)` with a rules fallback; read it). The agent routes (M5) already expose `POST /api/audit/scope/draft`; **you provide the real `catalog()`** in `src/audit/catalog.ts`: `{ recordId, kind: 'decision' | 'outcome', cycleId, cycleLabel, flagged, executedAt }[]` from decision records and outcomes (flagged = verdict NeedsApproval or any failed blocking check). The orchestrator will pass your catalog to the scope drafter.
- **API contract: `packages/shared/src/api/audit.ts`** (read it in full). Do not change existing shared schemas; report problems.
- Networks: LocalNet signs server-side for the auditor and treasurer. On MainNet these writes are signed in Grofty (M10): return `409 sign_in_wallet` with `On MainNet this is signed in Grofty Wallet. Open it from the button on this page.` for auditor and treasurer writes when `config.network === 'mainnet'`.

## Requirements (verbatim from specs.md)
| ID | Requirement | Acceptance |
|---|---|---|
| L8 | An auditor sees records only through an active access grant, and only the records listed in it. | Script: auditor query before grant returns nothing; after grant returns exactly the listed records. |
| L9 | An access grant has an expiry. After expiry, the agent (or any stakeholder) can close it, and the auditor loses visibility of the shared records. | Script: close after expiry succeeds, auditor view empty afterward; close before expiry by the agent fails. |
| A8 | MUST draft audit scopes from plain English as a list of record IDs, each with a reason, preferring the smallest set that answers the request. | Demo request produces a scope the treasurer can inspect record by record. |
| A9 | MUST close expired grants automatically within 5 minutes of expiry. | Integration test with a short expiry. |
details.md: "Activity log: every request, approval, execution, grant and expiry, readable by the treasurer." userflow 11.8: "Activity log on the treasurer side shows request, scope, grant, every view session, and expiry."

## Files and behavior
- `src/audit/catalog.ts` — `createAuditCatalog({ ledger, names })` → `() => Promise<CatalogEntry[]>` plus `labelFor(recordId)` ("Decision record, September 2026" / "Outcome, September 2026").
- `src/audit/evidence.ts` — pure mappers from `SharedRecord` payloads (`EvDecision` / `EvOutcome`) to `EvidenceRecord`: holders labelled "Holder A", "Holder B"… by party-id order across the grant's records (consistent across records of one grant); approvers labelled by display name (approvers are the fund's staff, not holders); payment links like the cycle engine's (MainNet explorer template; LocalNet `/auditor/tx/<updateId>` — the update id comes from `tx_refs`). Treasurer preview mappers (`RecordPreview`: one-line summary "1,200 CC to 4 holders, flagged, approved 2 of 3").
- `src/audit/service.ts` — `createAuditModule({ config, db, ledger, names, activity, bus })` → `{ routes, catalog }` where `routes` is a Fastify plugin:
  - `POST /api/audit/requests` (auditor) `CreateAuditRequest` → creates `AuditRequest` as the auditor (requestId `audit-<yyyymmdd>-<6 chars>`; scope items must exist in the catalog; labels from the catalog); activity "Auditor <name> requested access: <question>" and "Scope: <n> records proposed".
  - `GET /api/audit/requests` (auditor: own; treasurer: all) → `AuditRequestsResponse`; status derived from ledger: pending (active request), granted (active grant), denied (`AccessDenied`), withdrawn (no request, no grant, no denial; keep a marker in `activity_log` when withdrawing), ended (`AccessClosed`).
  - `GET /api/audit/requests/:requestId` → `AuditRequestDetail` (`preview` only for the treasurer).
  - `POST /api/audit/requests/:requestId/grant` (treasurer) `GrantAccessRequest` → `Org_GrantAccess` with the evidence refs for the chosen record ids (must be a subset of the scope) and `expiresAt = now + 24 h / 7 d / 30 d`; activity "Access granted to <auditor> until <date> (<n> records)"; `audit` event.
  - `POST /api/audit/requests/:requestId/deny` (treasurer) `DenyAccessRequest` → `Org_DenyAccess`; activity "Request denied".
  - `POST /api/audit/grants/:grantId/revoke` (treasurer) → `AccessGrant_Revoke`; activity.
  - `POST /api/audit/requests/:requestId/withdraw` (auditor, pending only) → `AuditRequest_Withdraw`.
  - `GET /api/audit/grants/:grantId/evidence` (auditor of that grant) → `EvidenceRoom` built **only** from `SharedRecord` contracts read **as the auditor** (`reader.as([auditor])`), never from treasury-side reads; after expiry or close → `410 access_ended` "Access ended <date>. Ask the fund for a new grant if you need these records again." (also when the grant is past `expiresAt` but the expiry job has not yet closed it). Logs a view session in the activity log at most once per 10 minutes per auditor and grant ("Auditor <name> opened the evidence room (<n> records)").
  - `GET /api/audit/grants/:grantId/export` (auditor) → `text/markdown` summary for working papers (question, grant dates, each record with its fields, fingerprints, approvals, payments with holder labels), `content-disposition: attachment; filename="mithra-evidence-<grantId>.md"`.
  - `GET /api/auditor/tx/:updateId` is **not** needed; links can point to `/auditor/tx/<updateId>` but if you implement it, return only the payments that are in the auditor's own shared records.
- Roles: an auditor can only see their own requests and grants (404 otherwise, never 403 with details); the treasurer sees all; approvers and holders get 403.

Tests:
- Unit: evidence mappers (holder labels stable and consistent, no party ids in holder labels), preview summaries, status derivation, request id format, expiresIn math.
- Integration (`test/integration/audit.test.ts`, sandbox `localhost:7575`, database `postgres://mithra:mithra@localhost:5432/mithra_test_m9`; create it with `su postgres -c "createdb -O mithra mithra_test_m9"`): build a test app with the session plugin and your routes (see how `test/integration/treasury.test.ts` builds its app). Set up on the sandbox: charter → organization → seal → units → two executed cycles (one flagged with approvals) using the M4 test helpers in `test/integration/cycleHelpers.ts` (import them; do not modify) or direct ledger commands. Then: auditor drafts nothing yet and `GET .../evidence` for a made-up grant → 404; auditor creates a request with the scope "Show all Q3 distributions and the approvals behind any flagged one" (use the rules fallback directly: `draftAuditScope` with no model, or build the items by hand); treasurer `GET` shows the preview; grant for 7 days with a subset of the scope → the auditor's evidence room contains exactly the granted record ids (L8) and no party id of any holder appears in the evidence JSON (string search); a second auditor sees nothing (404); revoke → 410; a second grant with a 2-second expiry → after 3 seconds the evidence route returns 410 even before the expiry job runs, then `startGrantExpiry(...).closeExpiredNow()` closes it and the auditor's ACS has no `SharedRecord` (L9, A9); activity log has request, scope, grant, view session, expiry entries; deny path; withdraw path.

## Acceptance checks you must run and pass
1. Your files pass lint, prettier, typecheck; `pnpm --filter @mithra/backend test` passes (if another implementer's in-progress file breaks the root, say so and show yours pass).
2. `npx vitest run --config vitest.integration.config.ts test/integration/audit.test.ts` (from `apps/backend`) passes.
3. The L8, L9 and A9 tests are clearly named.

## Constraints
- TypeScript strict; no `any` without a comment explaining why.
- Zod-validate every input with the shared schemas.
- The auditor's evidence comes only from the auditor's own ledger view.

## When you finish, report
1. Files changed.
2. Exact commands you ran and their output.
3. Each acceptance check: pass or fail, with evidence.
4. Deviations and why.
5. Open questions, and the exact wiring lines for `app.ts`/`index.ts` (`createAuditModule` deps, plugin registration, passing `catalog` to the scope drafter).
