#!/usr/bin/env bash
# Take one LocalNet node offline and bring it back (the BitSafe demo: the treasury keeps working on 2 of 3 nodes).
#   scripts/localnet-node.sh b offline
#   scripts/localnet-node.sh b online
#   scripts/localnet-node.sh c offline --allow-c   only for scripts/bitsafe-demo.sh (below-threshold demo, see below)
#   scripts/localnet-node.sh console     open the stock interactive Canton console (to look up command names)
# All three participants run in one container, so this disconnects the participant from its synchronizers
# through the Canton console (localnet/console/node-offline.sc and node-online.sc) instead of stopping it.
# Node A and node C cannot be taken offline: A hosts the agent and every demo party, C hosts the DSO and the
# synchronizer. The one exception is node C with --allow-c, for the below-threshold step of
# scripts/bitsafe-demo.sh: that script sets MITHRA_ALLOW_C_OFFLINE=bitsafe-demo, and without it --allow-c is
# refused. While C is offline CC transfers stop for everybody (C hosts the DSO); bring C back with
# `scripts/localnet-node.sh c online`. Needs a running LocalNet (scripts/localnet-up.sh).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

usage() {
  print_usage "${BASH_SOURCE[0]}"
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

need_cmd jq "Install jq."
load_config

ALLOW_C=0
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --allow-c) ALLOW_C=1 ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done
NODE="${POSITIONAL[0]:-}"
ACTION="${POSITIONAL[1]:-}"

if [ "$NODE" = "console" ]; then
  need_cmd docker "Install Docker."
  [ -f "$LOCALNET_DIR/compose.yaml" ] || die "LocalNet bundle not found in localnet/.cache. Run scripts/localnet-up.sh first."
  exec docker compose -p "$LOCALNET_PROJECT" \
    --env-file "$LOCALNET_DIR/compose.env" --env-file "$LOCALNET_DIR/env/common.env" \
    -f "$LOCALNET_DIR/compose.yaml" -f "$LOCALNET_DIR/resource-constraints.yaml" \
    --profile sv --profile app-provider --profile app-user --profile console run --rm console
fi

case "$NODE" in a | b | c) ;; *)
  usage >&2
  die "first argument must be a, b, c or console"
  ;;
esac
case "$ACTION" in offline | online) ;; *)
  usage >&2
  die "second argument must be offline or online"
  ;;
esac

LABEL="$(node_label "$NODE")"
PARTICIPANT="$(node_get "$NODE" PARTICIPANT)"

if [ "$ALLOW_C" = "1" ]; then
  if [ "$NODE" != "c" ] || [ "$ACTION" != "offline" ]; then die "--allow-c only applies to: scripts/localnet-node.sh c offline --allow-c"; fi
  [ "${MITHRA_ALLOW_C_OFFLINE:-}" = "bitsafe-demo" ] ||
    die "refusing --allow-c: taking node C offline is only allowed from scripts/bitsafe-demo.sh (it stops CC transfers for everybody)."
  printf '\n!!! WARNING: taking node C offline. C hosts the DSO and the synchronizer, so ALL Canton Coin transfers stop\n!!! (payouts, funding, auto-receive) until you run: scripts/localnet-node.sh c online\n\n' >&2
fi

if [ "$ACTION" = "offline" ] && [ "$ALLOW_C" != "1" ]; then
  case "$NODE" in
    c) die "refusing to take node C offline: it hosts the DSO and the synchronizer (the LocalNet sv), so taking it offline stops all CC transfers, not just the treasury. For the BitSafe demo take node B offline. (scripts/bitsafe-demo.sh takes C offline itself for the below-threshold step, using --allow-c.)" ;;
    a) die "refusing to take node A offline: it hosts the agent, the operator and every demo party, so the app itself would stop. For the BitSafe demo take node B offline." ;;
  esac
fi

need_cmd docker "Install Docker."
[ -f "$LOCALNET_DIR/compose.yaml" ] || die "LocalNet bundle not found in localnet/.cache. Run scripts/localnet-up.sh first."

log_info "Node $LABEL ($PARTICIPANT): $ACTION ..."
MITHRA_PARTICIPANT="$PARTICIPANT" MITHRA_CONSOLE_SCRIPT="node-$ACTION.sc" \
  localnet_console_compose run --rm -T console ||
  die "the Canton console script failed. See localnet/console/node-$ACTION.sc (command names are marked 'verify on owner's machine')."

state_init
if [ "$ACTION" = "offline" ]; then
  state_set ".nodes[\"$NODE\"].offline" true
else
  state_set ".nodes[\"$NODE\"].offline" false
fi
log_ok "Node $LABEL is $ACTION. Check with scripts/localnet-status.sh"
