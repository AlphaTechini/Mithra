#!/usr/bin/env bash
# Stop DecMan and LocalNet.
#   scripts/localnet-down.sh           stop and remove the containers, keep all data (restart with localnet-up.sh)
#   scripts/localnet-down.sh --reset   also delete the LocalNet volumes, localnet/.data (DecMan keys) and localnet/.state
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

RESET=0
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=1 ;;
    -h | --help)
      print_usage "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) die "unknown argument: $arg (use --reset or --help)" ;;
  esac
done

need_cmd docker "Install Docker."
load_config

log_info "Stopping DecMan ..."
decman_compose down

if [ -f "$LOCALNET_DIR/compose.yaml" ]; then
  log_info "Stopping LocalNet ..."
  if [ "$RESET" -eq 1 ]; then
    localnet_compose --profile sv --profile app-provider --profile app-user --profile console down -v
  else
    localnet_compose --profile sv --profile app-provider --profile app-user --profile console down
  fi
else
  log_info "No LocalNet bundle in localnet/.cache, nothing to stop."
fi

if [ "$RESET" -eq 1 ]; then
  log_info "Deleting localnet/.data and localnet/.state ..."
  if ! rm -rf "$DATA_DIR" "$STATE_DIR" 2>/dev/null; then
    log_warn "could not delete some files (owned by the DecMan container user); retrying through Docker"
    docker run --rm -v "$LOCALNET_ROOT:/w" busybox:1.37.0 sh -c 'rm -rf /w/.data /w/.state' ||
      die "could not delete $DATA_DIR and $STATE_DIR; remove them with sudo"
  fi
  log_ok "LocalNet reset. scripts/localnet-up.sh starts from scratch."
else
  log_ok "LocalNet stopped. Data is kept; scripts/localnet-up.sh brings it back."
fi
