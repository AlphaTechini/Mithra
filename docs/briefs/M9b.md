You are the implementer for milestone M9b: Audit screens, in the Mithra repository at /home/user/Mithra.
Write all code and tests for this milestone. Work only in `apps/web/src/routes/auditor/` (layout exists from M6; you own it now), `apps/web/src/routes/app/audit/` (the treasurer's audit pages), `apps/web/src/routes/launch/` (one fix, below), `apps/web/src/lib/api/audit.ts`, `apps/web/src/lib/components/audit/`. Do not commit or push. Backend implementers are building the endpoints you call and wiring the backend; **never touch anything outside your paths.** Reuse shared components; if you need a change to one, describe it in your report instead. Do not add npm dependencies.

## Goal
The auditor's workspace (requests on the left, evidence room on the right) and the treasurer's audit pages implement userflow section 11 end to end against the audit API: plain-English request → the agent's proposed scope, record by record with reasons and what is excluded → refine → **Request access** → "Request sent"; the treasurer opens the request, sees the exact records that would be shared side by side with the auditor's question, picks an expiry (24 hours, 7 days, 30 days), **Grant access** (seal, "Access granted until {date}") or **Deny**; the auditor's read-only evidence room with a ring that empties as expiry approaches and an export; at expiry both sides see "Access ended {date}" and the records disappear.

## Context
- **Read `userflow.md` sections 1, 11, 13, 14 in full**; `details.md` sections 5 (auditor sees only records inside an active, unexpired grant) and 6.
- Design system (M6/M7): `apps/web/src/lib/components/` — `Seal` (use `state="expiring"` with `grantedAt`/`expiresAt` for the grant ring; `required`/`signed` for the treasurer's single-signature grant seal), `StatusChip` (kinds `active`, `expired`, `denied`, `pending`…), `DataTable`, `Amount`, `ActionCard`, `Skeleton`, `EmptyState`, `ErrorState`, `PendingNotice`, `PartyId`, `Dialog`, `Field`, `AppLink` (use it for server-provided links; the lint rule rejects bare dynamic hrefs), `PageHeader`, `Toast` store, `lib/api/client.ts` (`apiGet`, `apiPost`, `ApiError`), `lib/stores/live.svelte.ts` (subscribe to `audit` events and refetch), `lib/format.ts` (dates).
- **API contract: `packages/shared/src/api/audit.ts`** (read in full):
  - `POST /api/audit/scope/draft { question }` → `ScopeDraft` (A8; `source: 'rules'` + `notice` when the model was unavailable — show the notice).
  - `POST /api/audit/requests` `CreateAuditRequest` → `AuditRequestDetail`; `GET /api/audit/requests` → `AuditRequestsResponse`; `GET /api/audit/requests/:requestId` → `AuditRequestDetail` (`preview` for the treasurer); `POST …/grant` `GrantAccessRequest`; `POST …/deny` `DenyAccessRequest`; `POST /api/audit/grants/:grantId/revoke`; `POST /api/audit/requests/:requestId/withdraw`.
  - `GET /api/audit/grants/:grantId/evidence` → `EvidenceRoom`, or `410 access_ended` with a message → show "Access ended {date}" state; `GET /api/audit/grants/:grantId/export` → a markdown download (use a normal link with `download`).
  - Errors `{ error: { code, message } }`; on MainNet writes may return `409 sign_in_wallet` (show the message in place; Grofty is M10).

## Requirements (verbatim from specs.md)
| ID | Requirement | Acceptance |
|---|---|---|
| L8 | An auditor sees records only through an active access grant, and only the records listed in it. | … |
| L9 | An access grant has an expiry. After expiry … the auditor loses visibility of the shared records. | … |
| A8 | MUST draft audit scopes from plain English as a list of record IDs, each with a reason, preferring the smallest set that answers the request. | Demo request produces a scope the treasurer can inspect record by record. |
| U3 | The seal ring reflects the true signature count from the ledger, never an optimistic local value. | … |
| U4 | Every screen handles loading, empty, error and pending states as described in `userflow.md` Section 13. | Review each screen. |
| U5 | Works at 375 px width; keyboard accessible; WCAG AA contrast; reduced-motion respected. | … |
| U9 | Copy follows the vocabulary table; buttons say exactly what happens. | Copy review. |
Vocabulary: **Request access** → "Request sent"; **Grant access** → "Access granted until {date}"; **Deny** → "Request denied".

## Screens
- `routes/auditor/+layout.svelte` + `routes/auditor/+page.svelte` — two panes: left, the auditor's requests (question, status chip, dates) and **New request**; right, the selected request or the evidence room. On phones the panes stack (list first, detail below, with a back control).
- New request (in the auditor workspace): a prompt box with the example "Show all Q3 distributions and the approvals behind any flagged one."; **Propose scope** → the proposed records listed one by one (label, reason, a checkbox to keep or drop each), the `excluded` sentence, the rules notice if any; the auditor can edit reasons; **Request access** → toast "Request sent", status Pending.
- Evidence room (`routes/auditor/grants/[grantId]/+page.svelte` or inside the workspace): header with the question, granted and expiry dates, the `Seal` ring in `expiring` state; each record: decision records (inputs fingerprint list, checks with actual values, memo, verdict, mandate version and cap, per-holder table with Holder A–D labels) and outcomes (approvals, payments with links); **Export summary** link; read-only (no inputs). On `410`: "Access ended {date}" with the records gone.
- `routes/app/audit/+page.svelte` (treasurer) — requests list (auditor, question, status, dates), pending first; empty state "No audit requests yet."
- `routes/app/audit/[requestId]/+page.svelte` (treasurer) — the auditor's question beside the exact records that would be shared (`preview`: label, summary, availability; checkboxes to share a subset), expiry picker (24 hours, 7 days, 30 days), **Grant access** → the seal closes from the server response and "Access granted until {date}"; **Deny** asks for a reason → "Request denied"; for an active grant: the expiry ring, the records shared, **End access now** (revoke); ended: "Access ended {date}".
- `routes/launch/+page.svelte` — honour `?next=<path>` (only same-site paths starting with `/`): after sign-in and choosing a party, go to `next` instead of `homeFor(primaryRole)` when present (the invite page links to `/launch?next=/invite/<code>`). Keep everything else unchanged; this is the only edit in that file.
- `lib/api/audit.ts` — typed calls parsed with the shared schemas.
- Tests (Vitest + Testing Library, stub `fetch`; see `apps/web/src/test/treasury/stub.ts` for the fetch router and fake EventSource used by M7 tests): scope proposal renders each record with its reason and dropping one removes it from the request body; request access shows "Request sent"; the treasurer page shows the question side by side with the preview and grant sends the chosen expiry and subset; deny requires a reason; the evidence room renders holder labels only (assert no party id strings from the fixture appear anywhere in the DOM, including attributes); `410` shows "Access ended"; the expiring seal renders with the right label; `/launch?next=/invite/ABC` navigates to the invite after choosing a party, and an off-site `next` (`//evil.example`) is ignored.
- Smoke screenshots with the pre-installed Chromium against `vite dev` and a throwaway mock API (delete it afterwards), 375 and 1280 px, of: auditor new request with a proposed scope, auditor evidence room, treasurer request review, ended state — into `/tmp/claude-0/-home-user-Mithra/0803c7b5-0b2a-5602-b9e1-deb09a3ff9ec/scratchpad/m9/`.

## Acceptance checks you must run and pass
1. `pnpm --filter @mithra/web lint`, `typecheck` (0 errors, 0 warnings), `test`, `build` pass.
2. The tests above exist and pass.
3. Screenshots exist; no horizontal scroll at 375 px; visible focus on every control.

## Constraints
- TypeScript strict; no `any` without a comment explaining why.
- All data from the API; nothing computed in the browser except formatting.
- Saffron only inside `Seal`.

## When you finish, report
1. Files changed.
2. Exact commands you ran and their output.
3. Each acceptance check: pass or fail, with evidence (screenshot paths).
4. Deviations and why; shared-component changes you needed (described, not made).
5. Open questions for the orchestrator.
