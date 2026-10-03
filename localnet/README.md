# Mithra LocalNet

A local Canton network with three participant nodes, one BitSafe Decentralization Manager (DecMan) per node, and the Mithra treasury as a Decentralized Party hosted on all three. One command brings it up from a clean machine.

```bash
scripts/localnet-up.sh              # idempotent; a second run prints "already done" per step
scripts/localnet-env.sh             # merge the generated settings into .env (keeps your secrets)
scripts/localnet-status.sh          # nodes, synchronizers, DecMan, treasury hosting
scripts/localnet-node.sh b offline  # BitSafe demo: node B stops confirming
scripts/localnet-node.sh b online
scripts/bitsafe-demo.sh             # BitSafe evidence run (writes docs/bitsafe-evidence/<timestamp>.md)
scripts/localnet-down.sh            # stop (keeps data); add --reset to wipe everything
scripts/localnet-up.sh --dry-run    # print every HTTP request, call no Docker
```

Needs Docker with compose 2.24 or newer, `jq`, `curl`, `openssl`, `base64`, `tar`, and about 8 GB of memory for Docker. The first run downloads the Splice bundle (about 760 MB, SHA-256 checked) and pulls the LocalNet and DecMan images. Step-by-step checks, with what each step should print: [docs/verification.md](../docs/verification.md).

## What runs

| Part     | What                                                                                                                                                      | From                                                                |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| LocalNet | Splice 0.6.12: one `canton` container with three participants, one `splice` container with three validators, one synchronizer, PostgreSQL, nginx, web UIs | the Splice release bundle, cached in `localnet/.cache/`             |
| DecMan   | three instances (`dm-a`, `dm-b`, `dm-c`), each talking to its own node and to the others over the Noise protocol                                          | `localnet/compose.decman.yaml`, image from `localnet/versions.env`  |
| Console  | Canton console container used only to take a node offline                                                                                                 | the bundle's `console` service plus `localnet/compose.console.yaml` |

LocalNet auth is the documented unsafe setup: HS256 JWT with secret `unsafe`, audience `https://canton.network.global`, user `ledger-api-user`, which is admin on every node. Never use it anywhere but LocalNet.

## Nodes, operators, thresholds

Defined in `localnet/nodes.env` (change names, operators and ports there; nothing is hard-coded elsewhere).

| Node | Operator                                       | LocalNet participant | Ledger API (gRPC) | JSON Ledger API       | DecMan UI/API         | Noise | Confirms Mithra actions   |
| ---- | ---------------------------------------------- | -------------------- | ----------------- | --------------------- | --------------------- | ----- | ------------------------- |
| A    | Mithra Labs (app provider)                     | `app-provider`       | 3901              | http://localhost:3975 | http://localhost:8081 | 9001  | automatically (backend)   |
| B    | Ledgerline Fund Services (fund administrator)  | `app-user`           | 2901              | http://localhost:2975 | http://localhost:8082 | 9002  | automatically (backend)   |
| C    | Canton super validator (synchronizer operator) | `sv`                 | 4901              | http://localhost:4975 | http://localhost:8083 | 9003  | by hand in its own DecMan |

Admin API ports are 3902, 2902 and 4902. LocalNet UIs: wallet and validator at http://localhost:3000 (app provider) and http://localhost:2000 (app user), scan at http://scan.localhost:4000.

- **Hosting threshold: 2 of 3.** The treasury party `mithra-treasury` is hosted on A, B and C. Two of the three nodes must confirm every transaction that uses the treasury's authority, and two of three owners must sign topology changes. One node can be offline and the treasury keeps working.
- **Governance threshold: 2 of 3.** BitSafe `GovernanceRules` for the treasury need two node confirmations to execute a governed action (the `TreasuryCharter` here, every Mandate change later).
- Each node is named with its operator in the DecMan peer list (`Node A - Mithra Labs (app provider)`).

## How the treasury party is created

`scripts/localnet-up.sh` drives DecMan's REST API (the steps follow DecMan's own end-to-end test):

1. Start LocalNet and the three DecMan instances; read each node's participant id and Noise public key.
2. Give every instance the full peer list, then restart the instances (peer keys load at startup).
3. On DecMan A, onboard `mithra-treasury` with peers B and C and threshold 2; B and C accept the invitation.
4. Allocate Mithra's parties on node A (operator, agent, treasurer, three approvers, four holders, auditor) and one member party per node (`mithra-member-a/b/c`); give `ledger-api-user` act and read rights; set each DecMan's party configuration.
5. Distribute the DARs (`governance-action-v1`, `governance-core-v1`, `mithra-v1`) to all three nodes.
6. Deploy `GovernanceRules` for the treasury (members = the three member parties, threshold 2); the Mithra operator is added as an additional proposer through a governed action confirmed on A and B.
7. As the operator, create a `CharterProposal`; confirm it on DecMan A and B, execute it. The governed action creates the `TreasuryCharter` with the treasury's authority.
8. Read the DSO party from the validator's scan proxy (the asset admin for Canton Coin).
9. Write everything the backend needs to `localnet/.state/localnet.env`.

All demo parties live on node A, so taking node B offline for the BitSafe demo never affects a payee.

## Files

| Path                               | Purpose                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `versions.env`                     | Splice version, bundle URL and SHA-256, DecMan image                                |
| `nodes.env`                        | node names, operators, ports, treasury hint, thresholds                             |
| `compose.decman.yaml`              | the three DecMan services on the external LocalNet network                          |
| `compose.console.yaml`, `console/` | console override and scripts for the node-offline demo                              |
| `.cache/`                          | downloaded bundle (ignored by git)                                                  |
| `.data/dm-a`, `dm-b`, `dm-c`       | DecMan keys and databases (ignored)                                                 |
| `.state/state.json`                | which bring-up steps are done, ids found along the way (ignored)                    |
| `.state/localnet.env`              | settings for the backend, merged into `.env` by `scripts/localnet-env.sh` (ignored) |

## Taking a node offline (BitSafe demo)

All three participants run in one container, so `docker stop` would stop them all. `scripts/localnet-node.sh b offline` runs a Canton console script that disconnects node B's participant from the synchronizer; it stays up but stops confirming. With B offline, A and C still reach the hosting threshold of 2, so Mithra cycles keep working; with two nodes offline, transactions that need the treasury time out. `online` reconnects it. Node A (hosts the agent and all demo parties) and node C (hosts the DSO and the synchronizer, so CC transfers stop everywhere) are refused. The one exception is `scripts/localnet-node.sh c offline --allow-c`, accepted only when `scripts/bitsafe-demo.sh` sets `MITHRA_ALLOW_C_OFFLINE=bitsafe-demo` for its below-threshold step; it prints a loud warning that CC transfers stop until `scripts/localnet-node.sh c online`.

`scripts/bitsafe-demo.sh` runs the whole BitSafe evidence (one node offline and a cycle still pays, below the hosting threshold, a governed Mandate change below and at its confirmation threshold) against the running backend and writes a report to `docs/bitsafe-evidence/`; see [docs/bitsafe.md](../docs/bitsafe.md) and [docs/verification.md](../docs/verification.md). The console command names are marked "verify on owner's machine" in `console/node-offline.sc`; `scripts/localnet-node.sh console` opens the stock console to check them.

## Operator note: the participant's list limit

The backend reads the ledger's active contracts with `POST /v2/state/active-contracts`. A participant refuses a result larger than its `http-list-max-elements-limit` (200 by default) with HTTP 413. The backend then repeats the read over the JSON API's WebSocket stream, which has no such limit, so a larger treasury keeps working with the default setting. If you want the plain HTTP read to cover your data too, raise the limit on the participant the backend talks to (node A), in its Canton configuration:

```
canton.participants.<participant-name>.http-ledger-api.websocket-config.http-list-max-elements-limit = 5000
```

Nothing in Mithra needs it. The WebSocket path needs the participant's JSON API port to accept WebSocket upgrades (it does by default) and, when the participant requires a token, accepts it as the `jwt.token.<token>` subprotocol; see [docs/research/ledger-api.md](../docs/research/ledger-api.md).

## Reset and troubleshooting

- `scripts/localnet-down.sh` stops everything and keeps data. `scripts/localnet-up.sh` brings it back.
- `scripts/localnet-down.sh --reset` also removes the LocalNet volumes, `localnet/.data` and `localnet/.state`. Use it after any manual `docker compose down -v`, or when you deleted only part of the state: the script refuses to continue when `state.json` names a treasury party the ledger does not know. Deleting only `localnet/.state` while the network is complete makes the script repeat the governed-action confirmations, so reset instead.
- Every wait has a timeout; a timeout names the step and prints the last response. Fix the cause and run `scripts/localnet-up.sh` again, finished steps are skipped.
- `LOCALNET_TRACE=1 scripts/localnet-up.sh` prints every HTTP request while it runs.
- `MITHRA_SPLICE_DIR=/path/to/splice-node` uses an already extracted bundle instead of the download.
