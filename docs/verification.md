# Verification

Step-by-step checks the owner runs on their own machine. The cloud environment this project was built in cannot pull the LocalNet or DecMan images, so everything that needs them is listed here with what to look for. Sections for later milestones are placeholders.

## LocalNet bring-up (owner's machine)

### Prerequisites

- Docker Desktop or Docker Engine with the compose plugin 2.24 or newer (`docker compose version`). The bundle's compose file uses `env_file` with `required: false`, which needs 2.24.
- `jq`, `curl`, `openssl`, `base64`, `tar` (all present on macOS and common Linux).
- Docker gets about 8 GB of memory (Docker Desktop: Settings, Resources). The script warns when it sees less.
- Network access to `github.com` (the Splice bundle), `ghcr.io` (LocalNet images) and `public.ecr.aws` (DecMan image). First run: about 760 MB bundle plus several GB of images, allow 10 to 20 minutes.
- Free host ports: 2000, 3000, 4000 (UIs), 2901/2902/2975, 3901/3902/3975, 4901/4902/4975 (nodes), 2903/3903/4903 (validators), 5432 (PostgreSQL), 8081 to 8083 (DecMan).
- A built Mithra DAR. `scripts/localnet-up.sh` builds it with `scripts/daml.sh build` when `daml/mithra/.daml/dist/mithra-v1-0.1.0.dar` is missing (needs `dpm` or Docker).

### Commands

```bash
git clone <repo> && cd Mithra
scripts/localnet-up.sh --dry-run     # optional: every HTTP request a fresh run makes, no Docker
scripts/localnet-up.sh               # the whole bring-up
scripts/localnet-env.sh              # merge localnet/.state/localnet.env into .env
scripts/localnet-status.sh           # check the result
```

Add `LOCALNET_TRACE=1` before `scripts/localnet-up.sh` to see every HTTP request as it happens. Rerun `scripts/localnet-up.sh` after any failure: finished steps are skipped and every wait has a timeout that names the step and the last response.

### What each step prints

A successful first run prints (ids shortened; yours differ; the "(already done)" suffix replaces the first wording on a rerun):

| # | Step | First-run line |
|---|---|---|
| 1 | Prerequisites | `✓ Prerequisites (docker compose 2.x.y, jq, curl, openssl)` |
| 2 | Splice bundle | `✓ Splice LocalNet bundle 0.6.12 downloaded, SHA-256 verified, extracted to localnet/.cache` (a hash mismatch deletes the file and stops with both hashes) |
| 3 | LocalNet | `✓ LocalNet running: 3 participants (app-provider, app-user, sv), validators, synchronizer` (after `docker compose up -d --wait`; JSON APIs on 3975, 2975, 4975 answer `/v2/version`) |
| 4 | Mithra DAR | `✓ Mithra DAR built: daml/mithra/.daml/dist/mithra-v1-0.1.0.dar` or `... (already done)` |
| 5 | DecMan | `✓ DecMan running on each node (A, B, C)` |
| 6 | Peers | `✓ DecMan peers configured: each instance knows all 3 peers, instances restarted` |
| 7 | Treasury party | `✓ Treasury party mithra-treasury::1220abcd... (hosted on A, B, C; threshold 2)`, preceded by no warning. A warning `the ledger API reports the treasury party as local on: ...` means a node does not (yet) report it |
| 8 | Demo parties | `✓ Demo parties on node A (11: operator, agent, treasurer, 3 approvers, 4 holders, auditor), ledger-api-user can act as them` |
| 9 | Member parties | `✓ Member parties mithra-member-a/b/c allocated, ledger-api-user can act as them, DecMan party-config set on each node` |
| 10 | DARs | `✓ DARs governance-action-v1, governance-core-v1 and mithra-v1 distributed and vetted on A, B, C` |
| 11 | GovernanceRules | `✓ GovernanceRules deployed for the treasury (00ab..., confirmations needed: 2 of 3)` |
| 12 | Operator proposer | `✓ Mithra operator mithra-operator::1220... allowed to propose governed actions (2 confirmations)` |
| 13 | TreasuryCharter | `✓ TreasuryCharter 00cd... created through a governed action (2 of 3 node confirmations)` |
| 14 | DSO party | `✓ DSO party DSO::1220... (asset admin for CC)` |
| 15 | Settings | `✓ Wrote localnet/.state/localnet.env`, then `LocalNet is ready. Next: scripts/localnet-env.sh` |

The second run prints the same lines ending in `(already done)` and changes nothing (steps 3 and 5 only confirm the containers and APIs are up, and step 15 rewrites `localnet.env` with the same values).

`localnet/.state/localnet.env` must contain: `NETWORK=localnet`, `LEDGER_JSON_API_URL=http://localhost:3975`, `LEDGER_USER_ID`, `LEDGER_AUTH_MODE=unsafe-hmac`, `LEDGER_HMAC_SECRET=unsafe`, `LEDGER_AUDIENCE`, `TREASURY_PARTY`, `AGENT_PARTY`, `OPERATOR_PARTY`, `ASSET_ADMIN_PARTY` (the DSO), `ASSET_ID=Amulet`, `ASSET_SYMBOL=CC`, `REGISTRY_URL=http://localhost:3000/api/validator/v0/scan-proxy`, `LOCALNET_DEMO_PARTIES` (9 entries: Treasurer, Approver 1 to 3, Holder A to D, Auditor), `LOCALNET_NODES` (3 entries, `autoConfirm` true for A and B, false for C), `LOCALNET_READ_AS_TREASURY`, `DECMAN_GOVERNANCE_THRESHOLD=2`, `DECMAN_GOVERNANCE_RULES_CID`, `DECMAN_MEMBER_PARTIES`. `scripts/localnet-env.sh` merges them into `.env` and warns when `LOCALNET_DEMO_PASSWORD` is not set there.

### Check the treasury party's hosting

1. **DecMan UI.** Open http://localhost:8081 (node A's DecMan; 8082 and 8083 are B and C). The decentralized parties view should list `mithra-treasury::1220...` with three hosting nodes (the peers are named `Node A - Mithra Labs (app provider)`, `Node B - Ledgerline Fund Services (fund administrator)`, `Node C - Canton super validator (synchronizer operator)`) and a threshold of 2. The UI layout was not available when this was written; if the view differs, use the API below.
2. **DecMan API.** `curl -s http://localhost:8081/decentralized-parties | jq` shows the party; the same call on 8082 and 8083 should show it too. `curl -s http://localhost:8081/participants-status | jq` shows each peer as reachable.
3. **Ledger API on each node.** With `T` the value of `TREASURY_PARTY` and a token from `. scripts/lib/common.sh && load_config && jwt_unsafe`:
   ```bash
   for p in 3975 2975 4975; do
     curl -s -H "Authorization: Bearer $(jwt_unsafe)" "http://localhost:$p/v2/parties/$(jq -rn --arg v "$T" '$v|@uri')" | jq '.partyDetails'
   done
   ```
   Each node should return the party with `isLocal: true`.
4. **`scripts/localnet-status.sh`** prints the node table (JSON API version, connected synchronizers `global`, DecMan up), the operators, each DecMan's `/participants-status`, and `hosted on (as seen by the nodes): A, B, C   hosting threshold: 2 of 3`, plus the rules and charter contract ids and the DSO party.
5. **Charter.** The charter is a `TreasuryCharter` visible to the treasurer on node A:
   ```bash
   scripts/localnet-status.sh | grep TreasuryCharter    # prints the charter contract id
   ```

### Check the BitSafe demo (node offline)

```bash
scripts/localnet-node.sh b offline      # prints "Node B is offline"
scripts/localnet-status.sh              # node B shows synchronizers "NONE (offline)"
scripts/localnet-node.sh b online
scripts/localnet-node.sh c offline      # refused: node C hosts the DSO and the synchronizer
scripts/localnet-node.sh a offline      # refused: node A hosts the agent and every demo party
```

### Reset

`scripts/localnet-down.sh` stops everything and keeps data; `scripts/localnet-down.sh --reset` also deletes the LocalNet volumes, `localnet/.data` and `localnet/.state`.

### Items to verify on the owner's machine

Everything below was built from the research notes and the bundle's files but could not be run (images are not pullable in the build environment). If one fails, the script stops at that step with the response; fix the item and rerun.

| # | What | Where it is used | What to look for |
|---|---|---|---|
| 1 | Image pulls work | step 3 (`ghcr.io/digital-asset/decentralized-canton-sync/docker/*:0.6.12`), step 5 (`public.ecr.aws/dlc-link/decentralization-manager:v1.13.0`) | `docker compose up` finishes; otherwise the script says which registry to check |
| 2 | LocalNet starts and stays healthy with the bundle's defaults on 8 GB | step 3 | `docker ps` shows `canton`, `splice`, `postgres`, `nginx` and the UIs healthy |
| 3 | DecMan data directory is writable by the container user (the script creates `localnet/.data/dm-*` with mode 0777) | step 5 | `docker logs dm-a` shows no permission error; `localnet/.data/dm-a` holds `noise.key` and `decpm.db` |
| 4 | DecMan accepts peer names with spaces and parentheses (`Node A - Mithra Labs (app provider)`) in `POST /network-config` | step 6 | 200 on all three; if rejected, set simple names in `peers_json` in `scripts/localnet-up.sh` |
| 5 | `POST /onboarding` returns at once (does not wait for B and C to accept) | step 7 | the script then accepts the invitations on B and C; a hang here means it blocks |
| 6 | Invitation shape: `GET /invitations` is `{"invitations":[{"id","invitation_type","status"}]}` with types `Onboarding`, `Dars`, `Contracts` | steps 7, 10, 11 | `pending_invitation` finds an invitation; the timeout message prints the actual response |
| 7 | `GET /decentralized-parties` lists the party; the script searches for any string starting with `mithra-treasury::` | step 7 | the response of `curl localhost:8081/decentralized-parties` contains the party id |
| 8 | Status shape `{"status": "completed"}` (or a one-key object) on `/onboarding/status`, `/dars/distribute/status`, `/contracts/status`; `failed` is fatal | steps 7, 10, 11 | the timeout message prints the response |
| 9 | Member parties: user-rights grant body `{"userId","identityProviderId","rights":[{"kind":{"CanActAs":{"value":{"party"}}}}]}` accepted by `POST /v2/users/ledger-api-user/rights` | steps 7, 8, 9 | HTTP 200; if 400, compare with the node's OpenAPI at `http://localhost:3975/docs/openapi` |
| 10 | `PUT /party-config` works in insecure mode with the Keycloak fields omitted | step 9 | HTTP 200 on all three; otherwise the error text says which field is required |
| 11 | DAR distribution succeeds although the governance DARs may already be vetted, and the Mithra DAR also lands on node A (the operator creates a `CharterProposal` there) | step 10 | `curl localhost:8081/packages/vetted` lists `mithra-v1`; step 13 fails with an unknown-package error otherwise |
| 12 | `GET /governance/state?party_id=...` contains the `GovernanceRules` contract id (the script reads `rules_contract_id`, `rules_cid`, `governance_rules_contract_id`, or the first `contract_id`) | step 11 | the timeout message prints the response; set the id by hand in `localnet/.state/state.json` under `rules_cid` if the shape differs |
| 13 | `GET /governance/confirmations?party_id=...` lists confirmations per action; the script takes confirmations from the entry that mentions the operator party (add-proposer) or the proposal contract id (charter) | steps 12, 13 | the timeout message prints the response |
| 14 | `governance_add_additional_proposer` (`core_self`) and `generic_vote` with description `MithraCreateCharter` (`core_domain`, `disclosed_contracts: []`) are accepted by confirm and execute | steps 12, 13 | execute returns 200 and a `TreasuryCharter` appears for the treasurer on node A |
| 15 | The treasury party reports `isLocal: true` on all three nodes through the JSON API (`GET /v2/parties/{party}`) | step 7 | a warning if not; then check DecMan's view |
| 16 | The hosting threshold of 2 is applied to the party-to-participant mapping | DecMan UI / API | the party shows threshold 2 with three hosts |
| 17 | DSO party: `GET http://localhost:3000/api/validator/v0/scan-proxy/dso-party-id` returns `{"dso_party_id": "..."}` (the path is listed in the bundle's validator API docs; the response shape is taken from Scan's `/v0/dso-party-id`) | step 14 | the script falls back to `http://scan.localhost:4000/api/scan/v0/dso-party-id`; check `curl -s -H "Authorization: Bearer $(jwt_unsafe)" localhost:3000/api/validator/v0/scan-proxy/dso-party-id` |
| 18 | Canton console commands `synchronizers.disconnect_all()`, `synchronizers.reconnect_all()`, `synchronizers.list_connected()` on the remote participants, and that `canton run` exits after the script | `scripts/localnet-node.sh b offline` | the status script shows node B with `NONE (offline)`, and `online` restores `global`; `scripts/localnet-node.sh console` opens a console to look up names |
| 19 | The console override works with the bundle's `console` service (it builds the image from `sgaunet/jwt-cli:latest`; all four profiles must be enabled) | node offline demo | `scripts/localnet-node.sh b offline` prints `[mithra] disconnecting app-user ...` |
| 20 | Taking node B offline leaves the treasury working on A and C (two of three) | BitSafe evidence, later milestone | see the BitSafe evidence section when it exists |

Already checked in the build environment: `bash -n` and `shellcheck` on all scripts; `docker compose config` for the DecMan file and for the console override merged with the bundle's compose files; the JWT helper against `jose`; the SHA-256 of the bundle (`e15e8263...cd73`) and the download, verify and extract path against a local copy; the whole bring-up, a rerun and the status, node and down scripts against a fake DecMan, fake ledger API and fake `docker` (checks the control flow and the JSON bodies, not the real services); `scripts/localnet-up.sh --dry-run` output.

## Seeding the demo history

After `scripts/localnet-up.sh` and `scripts/localnet-env.sh`, `pnpm seed:localnet` creates real history on LocalNet, tagged "Seeded" in the UI (U8). Every step prints one line and skips itself when it is already done, so a second run prints `already done` everywhere and ends with `Nothing to do: the demo history is already in place.`

| Step | What it creates | Line on a first run |
|---|---|---|
| Organization | Northwind Income Fund, Approver 1 to 3, threshold 2 | `Organization: created Northwind Income Fund with Approver 1 to 3, threshold 2` |
| Mandate | The default policy, sealed (waits for the node confirmations) | `Mandate: sealed version 1 (cap 5,000 CC, 2 of 3 approvals, Monthly on the 1st at 09:00 UTC)` |
| Units Holder A to D | 100, 300, 600 and 1,000 units, effective 2026-05-01 | `Units Holder A: issued 100 units, effective 2026-05-01, seeded` |
| Treasury funds | 20,000 test CC when the balance is under 10,000 | `Treasury funds: added 20,000 CC (was 5,000, now 25,000)` |
| Auto-receive Holder A to C | A transfer preapproval through `Funding.createPreapproval`, skipped when the registry already reports `direct` for the holder; the step waits until the registry shows it | `Auto-receive Holder A: turned on` |
| Cycle 2026-06, Cycle 2026-07 | June (400 CC) and July (420 CC), run through the cycle engine and paid | `Cycle 2026-06: ran 400 CC, awaiting-acceptance, seeded` |

What to look for afterwards:

- **June and July only.** The Cycles list shows June 2026 and July 2026 with the "Seeded" tag. August and September are left for the live demo: August clean (300 CC), September flagged (Holder C's units jump just before the record date, 1,200 CC against an average of about 400 CC). See `docs/demo-script.md`.
- **Only Holder D is pending.** Holders A to C have auto-receive, so their payments in both cycles are Paid. Holder D has none, so Holder D's payment in both cycles shows "Awaiting acceptance" and the cycle status is `awaiting-acceptance`; Holder D accepts it on their Payments screen. This is the one place the demo shows the pending-acceptance path.
- **Balance.** 24,180 CC after the first run on a treasury that started at 5,000 CC (5,000 + 20,000 - 400 - 420).

`pnpm seed:localnet --sandbox` runs the same steps against the Canton sandbox world of the full-stack test server (test token registry; the world is kept in `.sandbox-seed-world.json`, delete it to start over). That world already gives Holders A to C auto-receive, so the three auto-receive lines read `already done (the registry reports direct)` even on the first run. Run it twice to see the idempotent second run (`Nothing to do`).

## Backend happy path

The same story over HTTP, without a browser, is `apps/backend/test/integration/fullstack.test.ts` (sessions, organization, the agent drafting the policy, sealing, units, a clean cycle with its countdown, a flagged cycle with two approvals, holder isolation, the overview, the activity log, live events, an auditor's scope). Run it with the Canton sandbox and PostgreSQL up: `cd apps/backend && npx vitest run --config vitest.integration.config.ts test/integration/fullstack.test.ts`. The browser version follows.

## Happy path in the browser (this environment)

`pnpm e2e` runs one Playwright test (`e2e/happy-path.spec.ts`, how it works: [e2e/README.md](../e2e/README.md)) in headless Chromium (the pre-installed 1194 build, Playwright 1.56.1) against the full-stack test server: the real application, every route and background job, on the Canton sandbox and PostgreSQL, with a test token registry, a direct Mandate sealer and a stub language model. It walks userflow section 0 as a person would, finding every control by its visible name:

landing, Launch app, sign in, Treasurer, organization (Approver 1 to 3, 2 of 3), policy described to the agent, Seal mandate ("Mandate sealed"), units for Holders A to D (100, 300, 600, 1,000, effective 2026-05-01), "Distribute 300 CC for August." (countdown, Hold, A to C Paid, D "Awaiting acceptance"), Holder D accepts the units and the payment, 900 more units for Holder C effective 2026-09-28, Run cycle now for September with 1,200 CC ("Needs 2 of 3 approvals", 2 flagged checks), Approver 1 then Approver 2 approve (seal 1 of 2, then closed), D's September payment waits again and D accepts it ("Paid after approval"), Holder A sees only Holder A, the Auditor asks for the Q3 records, the Treasurer grants 24 hours, the evidence room shows the records with Holder A to D labels and every payment Paid, the Treasurer ends access, the Auditor sees "Access ended", and the landing page then replays the real September distribution from `GET /api/public/showcase`.

Result of the last run: **1 passed (about 50 s of test, about 1 minute with the server start)**, screenshots of 28 key steps in `e2e/screenshots/` (git-ignored). Along the way: axe on eight screens with zero serious or critical violations, the keyboard checks (skip link, visible focus, dialogs trap focus and give it back, Escape closes the agent panel, Ctrl+K), reduced motion, and the landing page at 375 px without sideways scrolling. Lighthouse accessibility (`pnpm e2e:lighthouse`): 100 on all seven pages (see [accessibility.md](accessibility.md)).

What the run found and fixed (real dead ends, each with a unit test): after creating the organization the app sent the new treasurer back to `/start` until a reload (the session was read before the organization existed); the auditor's "Propose scope" failed with "The server sent something Mithra could not read" (the route's answer lacked the `label` and `notice` fields the screen needs); the evidence room showed raw status names, and kept showing "awaiting-acceptance" or "awaiting-signature" for payments recorded as paid after the outcome was written. What it did not cover: MainNet payouts (needs Grofty), LocalNet with real images and BitSafe nodes, the OpenAI model, Settings, Activity and invites in the browser.

## Active contracts above the participant's list limit (sandbox)

What was checked on 2026-10-02 against the sandbox that `scripts/sandbox.sh start` runs (Canton 3.4.0-rc2, no authentication, default list limit):

1. The plain HTTP read refuses a result above the limit. With 201 or more matching contracts, `POST /v2/state/active-contracts` answers `413` with code `JSON_API_MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED` ("The number of matching elements (201) is greater than the node limit (200)."). The error says `errorCategory: 2` (transient), but the same request fails again, so the client does not retry it.
2. The WebSocket stream of the same endpoint (`ws://localhost:7575/v2/state/active-contracts`, subprotocol `daml.ws.auth`, the HTTP request body as the first message) returned all 712 active contracts the sandbox held at that moment, one message each, then closed with code 1000. Without the `daml.ws.auth` subprotocol Node 22's `WebSocket` crashes in undici, because the sandbox answers with it anyway; the client always sends it.
3. `test/integration/ledger.test.ts`, "reads more active contracts than the list limit allows over the WebSocket stream": creates 205 `TestHolding` contracts for a new party, shows the HTTP read answering 413, then reads them through `LedgerClient.activeContracts`, which opens exactly one WebSocket and returns 205 distinct contracts with their payloads. A read below the limit does not open one. Run it with `scripts/sandbox.sh start` and `cd apps/backend && npx vitest run --config vitest.integration.config.ts test/integration/ledger.test.ts`.

The client uses the stream only after a 413, not for every read. Not verified: a participant that requires a token (the sandbox has none), where the token goes in the `jwt.token.<token>` subprotocol; a unit test (`src/ledger/client.test.ts`) checks the subprotocols and the `wss://` URL for https. To raise the limit on a LocalNet participant instead, see the operator note in [localnet/README.md](../localnet/README.md).

## BitSafe evidence (owner's machine)

`scripts/bitsafe-demo.sh` runs the whole N8 demonstration against the running LocalNet and backend and writes a timestamped report to `docs/bitsafe-evidence/`. It was written without a LocalNet (images cannot be pulled in the build environment): `bash -n`, `shellcheck`, `--dry-run` and a run against stub services were checked, the real run is yours. What it proves and the node, operator and threshold list: [docs/bitsafe.md](bitsafe.md).

### Before you run it

- LocalNet up and the backend running against it: `scripts/localnet-up.sh`, `scripts/localnet-env.sh`, then the backend and its database as in the README. `LOCALNET_DEMO_PASSWORD` is in your `.env` (the script reads the environment first, then `.env`).
- The demo history seeded (`pnpm seed:localnet`): the script needs the organization and the sealed Mandate, and the seeded balance for the payouts.
- Start the backend with its output also in a file, for example `pnpm --filter @mithra/backend dev 2>&1 | tee /tmp/backend.log` (or `node apps/backend/dist/index.js 2>&1 | tee ...` for the built backend), and pass `--backend-log /tmp/backend.log`. Below the hosting threshold the backend writes one line starting `[mithra-ledger] treasury nodes did not confirm:` with the raw Canton error; the report copies it, and it is how the unverified error id list in `apps/backend/src/ledger/errors.ts` gets corrected.
- **It uses up two cycle ids and pays real test CC for one of them.** Step 2 pays a cycle (default: the previous month, 400 CC); step 3 proposes another (the month before, cancelled afterwards unless `--keep`). Both months are the ones the live demo (`docs/demo-script.md`) uses for August and September, so run the evidence on a LocalNet you will reset afterwards (`scripts/localnet-down.sh --reset`, bring-up, seed) or pass `--cycle YYYY-MM` and `--below-cycle YYYY-MM` with months that have not run and whose record date is already past and after the units' effective date (2026-05-01).
- Step 3 takes node C offline, which stops all CC transfers until it is back. Nothing else should be running against that LocalNet. The script brings nodes B and C back when it ends, also after an error or Ctrl+C; if the machine itself dies, run `scripts/localnet-node.sh c online` and `scripts/localnet-node.sh b online`.

### Commands

```bash
scripts/bitsafe-demo.sh --dry-run                       # every request it would make, nothing is sent
scripts/bitsafe-demo.sh --backend-log /tmp/backend.log  # the real run, about 10 to 25 minutes
scripts/bitsafe-demo.sh --cycle 2026-09 --below-cycle 2026-08 --total 400   # explicit cycles
git add docs/bitsafe-evidence/ && git commit -m "BitSafe evidence: LocalNet run"
```

Options: `--keep` leaves the step 3 proposal and the step 4 cap change in place; `--url` or `MITHRA_URL` points at another backend (default `http://localhost:8787`). Wait times can be changed with `BITSAFE_INFRA_WAIT`, `BITSAFE_CYCLE_WAIT`, `BITSAFE_BELOW_WAIT`, `BITSAFE_SEAL_OBSERVE`, `BITSAFE_SEAL_WAIT` (seconds). The exit code is 0 only when every claim passed.

### What each step should print

| Step | What happens | Lines to expect |
|---|---|---|
| 1 Baseline | Records `scripts/localnet-status.sh`, `GET /api/infrastructure`, and `GET /decentralized-parties` on each DecMan; asks each node's ledger API whether it hosts the treasury | `✓ B2 ... 3 of 3 nodes`, `✓ B1 ... hosted on A, B, C; threshold 2` |
| 2 One node offline | `scripts/localnet-node.sh b offline`; the panel says "Still running on 2 of 3 nodes"; runs a cycle within the cap and waits for `paid-automatically` or `awaiting-acceptance` (Holder D has no auto-receive, so `awaiting-acceptance` is normal); records the payout update ids; brings B back | `✓ O1`, `✓ O2 ... payout update ids: ...` |
| 3 Below threshold | B and C offline (`localnet-node.sh c offline --allow-c`, allowed only from this script); the panel says "Below threshold: 1 of 3 nodes online"; runs a new cycle whose total is above the cap; it must not complete and should end `failed` with the message "The treasury's nodes did not confirm in time. At least 2 of its 3 nodes must be online; check Settings › Infrastructure, then try again."; brings C and B back, retries the same cycle (a failed cycle starts a new attempt), which now proposes (`awaiting-approval`); cancels it unless `--keep` | `✓ T1`, `✓ T2`, `T3`, `✓ T4` |
| 4 Governed action | B offline; drafts a Mandate change (cap 4,000; 4,500 when the cap is already 4,000) and seals it; watches the seal for 60 s: it must stay `awaiting-nodes` with 1 of 2 confirmations and the Mandate version and cap must not change; B back online: the seal reaches `sealed`, the Mandate has the next version and the new cap; a second seal restores the original cap | `✓ G1`, `✓ G2`, `✓ R1` |

Expect step 3 to take the longest: the backend's ledger client waits and retries before it gives up on a submission that cannot get its confirmations (several minutes).

### If a claim fails

- **T3 fails with a different message.** Expected until the Canton error id is confirmed: the report shows the message the app showed (the raw Canton text, since it was not mapped) and, with `--backend-log`, the `[mithra-ledger]` line. Add the real id to `NODE_CONFIRMATION_ERROR_IDS` in `apps/backend/src/ledger/errors.ts`, add it to the unit test, run again. A submit that times out in the HTTP client is mapped to the same message (the client passes the request path to `ledgerUnreachable`), and API routes answer it as a 503 with code `treasury_nodes_unconfirmed`; the raw error is still written to the backend's stderr as a `[mithra-ledger]` line.
- **O1 or T1 never matches.** The panel's answer is cached for 30 s and each node check has a 2 s timeout; the script waits 90 s. A node that still shows online after `localnet-node.sh ... offline` means the console command did not disconnect it: check `scripts/localnet-node.sh console` (items 18 and 19 of the table above).
- **G1 fails because confirmations are 0.** Node A's DecMan did not confirm: check `docker logs dm-a` and the response shapes (item 13 above).
- **A step needs a different cycle.** "Cycle ... already ran": pass `--cycle` or `--below-cycle`.

Item 20 of the table above is what this section answers: taking node B offline leaves the treasury working on A and C.


## MainNet payouts with Grofty (owner's machine)

`NETWORK=mainnet` means **MainNet payouts**. There is no MainNet node, so Mithra cannot host its Daml package or read the MainNet ledger: every Mithra record (organization, Mandate, proposals, approvals, decision records, payments, audit grants) stays on the **LocalNet** ledger, signed on the server through the role switcher exactly as on LocalNet (decision 11 in [decisions.md](decisions.md)). What changes is the money: a cycle the Mandate clears is paid as real CC transfers from the treasurer's Grofty Wallet, signed in the browser, one per holder. The server never moves MainNet funds, and the browser submits nothing to Canton except those transfers. Everything below needs a real Grofty Wallet and real (small) amounts of CC, so it was written and tested without them (fake provider in the unit tests, a fake Grofty in `apps/backend/test/integration/mainnet.test.ts`); this is what you run.

### Environment

A MainNet `.env` is the LocalNet `.env` (LocalNet up, `scripts/localnet-env.sh`, demo password, parties, DecMan variables: the records live there) plus:

| Variable | Value |
|---|---|
| `NETWORK` | `mainnet` |
| `MAINNET_EXPLORER_TX_URL` | the MainNet explorer's link for one transaction, with `{updateId}` in it (see below) |
| `GROFTY_MIN_VERSION` | `2.0.4` (the default) |
| `MAINNET_SCAN_URL` | optional: a public Scan base URL; with it the holders table and the holder home can say whether a holder's auto-receive is on |

`LEDGER_AUTH_MODE` now defaults to `unsafe-hmac` on both networks (the ledger that holds the records is the LocalNet one). The top badge reads "MainNet payouts · records on LocalNet". Use a browser with the Grofty Wallet extension (version 2.0.4 or newer) for the treasurer and each holder.

### Steps, with small amounts

1. Start LocalNet, the backend (`NETWORK=mainnet`) and the web app as for LocalNet, seed or set up the fund as usual (organization, policy, seal, issue units). Sign in with the demo password and the role switcher as on LocalNet; the launch page says payouts are signed in Grofty.
2. **Holders connect Grofty.** As each holder, open the welcome page (or Holder home): **Connect Grofty Wallet**. Grofty asks to connect, then to sign a message ("Connect your Grofty Wallet to Mithra ... Nonce ..."). The server checks that the wallet's party id belongs to the key that signed and stores the pairing. The holders table shows each holder's wallet as connected.
3. **Holders turn on auto-receive** (N5, for the Grofty video): the welcome page lists the steps; do them in Grofty, then press **Check again**. With `MAINNET_SCAN_URL` set the page says "Auto-receive is on"; without it the page says Mithra cannot check this from here.
4. **Treasurer runs a cycle** with a small total (for example 3 CC split over the holders; keep the Mandate's fee buffer in mind) with "Run cycle now". Inside the cap the countdown runs, then the ledger checks the Mandate rules; a flagged cycle first needs its approvals. If a holder has not connected Grofty the cycle shows "Waiting for holders to connect Grofty" and lists them; it goes ahead by itself when they have.
5. **Treasurer signs the payouts.** The cycle page shows **Sign payouts in Grofty**: connect, the balance check (the wallet must hold the amount still to send plus the fee buffer; otherwise "Add funds" with both numbers), then **Pay in Grofty** on each row, one at a time. Approve in Grofty within 3 minutes. A row stays "Pending ledger confirmation" until the server has recorded the transfer; then it says "Paid" (or "Awaiting acceptance" when the holder must accept an offer) with a link to the explorer. Each holder's home shows the payment and its link.
6. Check each link opens the transfer on the explorer, in a new tab.

### Owner-verification items (each is a guess that could not be checked here)

| # | Item | What to check | If it differs |
|---|---|---|---|
| M1 | `signMessage` encoding | The registration succeeds. Grofty's signature is read as base64 or hex of an Ed25519 signature over the UTF-8 bytes of the challenge message, and the public key as base64 or hex, raw (32 bytes) or DER (44 bytes). Failure shows "Grofty's signature did not match this wallet. Try connecting again." | Look at what `signMessage` returns in the browser console (`apps/web/src/lib/wallet/grofty.ts`) and adjust `decodeBytes` / `verifyMessageSignature` in `apps/backend/src/mainnet/fingerprint.ts`. If the wallet signs a hash or a prefixed message, change what is verified there. |
| M2 | Party namespace rule | The holder's party id ends in the fingerprint of the key Grofty reports: `1220` + SHA-256(uint32_be(12) \|\| key bytes). The check also accepts the fingerprint of the key in its DER form. | If neither matches, a real Grofty party is derived another way; fix `partyMatchesKey` in `fingerprint.ts` (one function, unit-tested with an independent implementation). |
| M3 | Scan preapproval endpoint | With `MAINNET_SCAN_URL` set, a holder with auto-receive on shows "Auto-receive is on". The code calls `GET {scan}/v0/transfer-preapprovals/by-party/{party}`: 200 on, 404 off, anything else unknown. The endpoint is unverified. | Correct the one function `lookupPreapproval` in `apps/backend/src/mainnet/scan.ts`. |
| M4 | `getBalance()` shape | The Add funds check shows your real balance. The reader accepts a number, `{ CC: "..." }`, `{ amount }` or a list with a CC entry. If it cannot read the answer the page warns and lets you sign (Grofty refuses a transfer it cannot cover). | Adjust `readBalance` in `apps/web/src/lib/wallet/grofty.ts`. |
| M5 | `getUpdateById` outcome heuristic | After a transfer the browser reads the transaction: a holding (`Amulet` or `Holding`) created for the receiver means completed, a transfer offer or instruction means pending, anything else unknown (recorded as paid with a note that acceptance could not be read). The treasurer's view may not include the receiver's new holding, in which case you will see "unknown" for transfers to receivers with auto-receive. | Look at the response for a transfer to a holder with auto-receive on and one without, and adjust `transferOutcome`. |
| M6 | Explorer URL | Each link opens the transfer. Set `MAINNET_EXPLORER_TX_URL` to the explorer's real format, with `{updateId}` where the update id goes (it must be the update id Grofty returns, not a contract id). | Change the variable. |
| M7 | Grofty menu wording | The auto-receive steps on the welcome page use approximate wording ("settings", "turn on receiving CC automatically"). | Fix the list in `apps/web/src/lib/components/holder/AutoReceiveControl.svelte` (the comment above it marks it). |
| M8 | Memo | Grofty shows the transfer memo `Mithra <fund name> <cycle label>` before you approve. | If the wallet ignores `memo` the payout still works. |
| M9 | Old wallet and timeout copy | A wallet older than 2.0.4 shows "Update Grofty Wallet to 2.0.4 or newer"; letting an approval sit for 3 minutes shows "Your wallet approval expired after 3 minutes. Approve again."; declining shows "You declined in Grofty. Nothing was sent." | The codes are 4001, 4100 and -32603; copy is in `grofty.ts`. |

What the ledger can and cannot say: `Payment_RecordExternal` records what the treasurer's browser reported Grofty did; the ledger cannot see MainNet, so it is the agent's attestation (stated in [ledger-model.md](ledger-model.md)). The explorer link is how anyone checks it.
