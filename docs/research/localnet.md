# Canton LocalNet (verified 2026-10-01)

Sources: Splice 0.6.12 release bundle (`github.com/digital-asset/decentralized-canton-sync/releases/download/v0.6.12/0.6.12_splice-node.tar.gz`), its `docker-compose/localnet/*` and `docs/html/app_dev/testing/localnet.html`; DecMan `integration-tests/env.sh` (uses the same bundle version 0.6.12 to boot LocalNet for its 3-node e2e); wallet SDK `sdk/wallet-sdk/src/config.ts`.

## What LocalNet is

Three participants (app-provider, app-user, sv), three validators, one synchronizer (the sv's, simulating the Global Synchronizer), PostgreSQL, nginx and web UIs. **All three participants run inside one `canton` container**; all validators run in one `splice` container. Images: `ghcr.io/digital-asset/decentralized-canton-sync/docker/{canton,splice-app,...}:${IMAGE_TAG}`.

Start (from docs):
```bash
export LOCALNET_DIR=$PWD/splice-node/docker-compose/localnet
export IMAGE_TAG=0.6.12
docker compose --env-file $LOCALNET_DIR/compose.env --env-file $LOCALNET_DIR/env/common.env \
  -f $LOCALNET_DIR/compose.yaml -f $LOCALNET_DIR/resource-constraints.yaml \
  --profile sv --profile app-provider --profile app-user up -d
```
DecMan's harness starts only `canton splice postgres` with `up -d --wait` (skips the UIs) and that is enough for ledger work. Use `down -v` to reset.

Canton console: `... run --rm console` (profile `console`).

## Ports (pattern `<prefix><suffix>`, prefix 4 = sv, 3 = app-provider, 2 = app-user)

| Suffix | Service | app-provider | app-user | sv |
|---|---|---|---|---|
| 901 | Ledger API (gRPC) | 3901 | 2901 | 4901 |
| 902 | Admin API (gRPC) | 3902 | 2902 | 4902 |
| 975 | JSON Ledger API | 3975 | 2975 | 4975 |
| 903 | Validator admin API | 3903 | 2903 | 4903 |

UIs: app-user 2000, app-provider 3000, sv 4000 (`wallet.localhost:2000`, `scan.localhost:4000`).

## Token standard registry and scan on LocalNet (wallet SDK constants)

- Validator API (app-user): `http://localhost:2000/api/validator`
- Registry API for CC (token standard off-ledger API, via scan proxy): `http://localhost:2000/api/validator/v0/scan-proxy` → `POST {registry}/registry/transfer-instruction/v1/transfer-factory`
- Scan: `http://scan.localhost:4000/api/scan`
- App-provider equivalents are on port 3000.

## Minting CC locally

LocalNet is a DevNet-style network (`SPLICE_SV_IS_DEVNET=true`), so `AmuletRules_DevNet_Tap` is enabled. Wallet SDK: `sdk.amulet.tap(partyId, '10000')` returns `[commands, disclosedContracts]` to submit as that party; `sdk.amulet.tapInternal('1000')` taps for the validator operator. For a Decentralized Party (which cannot submit directly), fund it by tapping into a local helper party and transferring to the treasury.

## Auth

Unsafe HMAC JWT, secret `unsafe`, audience `https://canton.network.global`, user `ledger-api-user` (admin on every participant). See `ledger-api.md`.

## Taking "one node offline"

All participants share one container, so `docker stop` would stop all three. Options, all through the Canton console (`run --rm console`), which connects to each node's admin API:
- `` `app-user`.synchronizers.disconnect_all() `` then `reconnect_all()` — the participant stays up but stops confirming. This is the method Mithra's N8 script uses (`scripts/node-offline.sh`).
Console command names come from the Canton console reference (docs.digitalasset.com, not reachable from this session) — **verify on the owner's machine**.

## Blocked in this cloud session

`ghcr.io` manifests resolve but blob downloads from `pkg-containers.githubusercontent.com` return 403 (network policy), so LocalNet cannot start here. The owner runs it locally; steps are in `docs/verification.md`.
