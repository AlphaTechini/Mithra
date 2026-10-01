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

## Backend happy path

To be written with the backend milestone: start the backend against `.env`, sign in as the demo treasurer, run a cycle, approve, execute, and what each screen shows.

## BitSafe evidence

To be written: the node-offline demo end to end (cycle with node B offline), the DecMan confirmation of a Mandate change on two of three nodes, screenshots or logs to keep.

## MainNet

To be written: Grofty wallet parties, OIDC auth, the MainNet registry and CC.
