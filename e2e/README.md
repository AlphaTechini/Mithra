# End-to-end happy path

One Playwright test that walks [userflow.md](../userflow.md) section 0 in a real (headless) browser against the real application:

landing page, Launch app, sign in, Treasurer, set up the organization (Approver 1 to 3, 2 of 3), describe the policy to the agent, review, **Seal mandate**, issue units to Holders A to D, "Distribute 300 CC for August." in the agent panel, the cycle page (countdown, Hold, rows become Paid, Holder D "Awaiting acceptance"), Holder D accepts the units and the payment, 900 more units for Holder C, **Run cycle now** for September with 1,200 CC (flagged, "Needs 2 of 3 approvals"), Approver 1 and Approver 2 approve, Holder D accepts again, Holder A sees only Holder A, the Auditor asks for the Q3 records, the Treasurer grants 24 hours, the evidence room shows the records with Holder A to D labels, the Treasurer ends access, the Auditor sees "Access ended". The test finds everything by its visible name and role, no test ids.

It also checks, along the way: the keyboard (skip link, visible focus, dialogs trap focus and return it, Escape closes panels), reduced motion, the landing page at 375 px, and **axe** on eight screens (landing, launch, overview, setup policy, cycle page flagged, holder home, auditor workspace, audit review): zero serious or critical violations are allowed. The axe counts by screen are printed at the end.

## Run

```sh
scripts/sandbox.sh start        # the Canton sandbox on :7575 (Docker); PostgreSQL 16 with mithra/mithra on :5432
pnpm e2e
```

`global-setup.ts` checks the sandbox, builds `apps/web` when `apps/web/build` is missing or older than its sources, starts `pnpm --filter @mithra/backend e2e:server` on a free port with `E2E_HOLD_SECONDS=5` (the Hold countdown), waits for `/api/health`, and stops the server afterwards. The server is the real app (every route, the scheduler, the reconciler) on the sandbox, with a test token registry instead of Amulet, a direct Mandate sealer instead of BitSafe governance, and a stub language model; it creates fresh parties on every start. Its log is `e2e/server.log`.

- Chromium: the pre-installed one in `/opt/pw-browsers/chromium` when it exists, else `E2E_CHROMIUM_PATH`, else Playwright's own (`npx playwright install chromium`, as CI does). Playwright is pinned to 1.56.1 to match the pre-installed browser.
- `E2E_DATABASE_URL` (default `postgres://mithra:mithra@localhost:5432/mithra_test_mw`, which is emptied on every start).
- Screenshots of the key steps go to `e2e/screenshots/` (git-ignored); traces and failure screenshots to `e2e/test-results/`. When the test fails it prints what the page showed.
- `pnpm e2e:lighthouse` also runs the Lighthouse accessibility audit on seven pages at the end of the story (needs `lighthouse` and the same Chromium; about 3 more minutes). Scores are recorded in [docs/accessibility.md](../docs/accessibility.md).
