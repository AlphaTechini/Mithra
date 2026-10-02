#!/usr/bin/env bash
# Show the state of the Mithra LocalNet: each node's JSON Ledger API version and connected synchronizers,
# each DecMan's /participants-status, and the treasury party's hosting (from localnet/.state/state.json).
# Exit code 1 when a node's JSON API cannot be reached.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

need_cmd jq "Install jq."
need_cmd curl "Install curl."
load_config
state_init

FAIL=0
HOSTED=""

printf '\n%-4s %-8s %-13s %-22s %-9s %-14s %s\n' NODE NAME PARTICIPANT "JSON API" VERSION SYNCHRONIZERS "DECMAN"
for n in $NODE_IDS; do
  ver="" syn="" dm="down"
  if out="$(ledger_curl "$n" GET /v2/version 2>/dev/null)"; then
    ver="$(printf '%s' "$out" | jq -r '.version // "?"')"
    syn="$(ledger_curl "$n" GET /v2/state/connected-synchronizers 2>/dev/null | jq -r '[.connectedSynchronizers[]?.synchronizerAlias] | join(",")' 2>/dev/null || true)"
    [ -n "$syn" ] || syn="NONE (offline)"
  else
    ver="unreachable"
    syn="-"
    FAIL=1
  fi
  if dm_curl "$n" GET /node-config >/dev/null 2>&1; then dm="up $(node_decman_url "$n")"; else dm="down"; fi
  printf '%-4s %-8s %-13s %-22s %-9s %-14s %s\n' "$(node_label "$n")" "$(node_get "$n" NAME)" "$(node_get "$n" PARTICIPANT)" "$(node_json_url "$n")" "$ver" "$syn" "$dm"
done

printf '\nOperators:\n'
for n in $NODE_IDS; do
  printf '  %s  %s  (auto-confirm for Mithra actions: %s)\n' "$(node_label "$n")" "$(node_get "$n" OPERATOR)" "$(node_get "$n" AUTO_CONFIRM)"
done

printf '\nDecMan /participants-status:\n'
for n in $NODE_IDS; do
  if out="$(dm_curl "$n" GET /participants-status 2>/dev/null)"; then
    printf '  %s  %s\n' "$(node_label "$n")" "$(printf '%s' "$out" | jq -c '.' 2>/dev/null | cut -c1-220)"
  else
    printf '  %s  not reachable\n' "$(node_label "$n")"
  fi
done

T="$(state_get '.treasury.party')"
printf '\nTreasury party:\n'
if [ -z "$T" ]; then
  printf '  not created yet (run scripts/localnet-up.sh)\n'
else
  printf '  %s\n' "$T"
  for n in $NODE_IDS; do
    local_flag="$(ledger_curl "$n" GET "/v2/parties/$(urlenc "$T")" 2>/dev/null | jq -r '(.partyDetails | if type == "array" then .[0] else . end).isLocal // false' 2>/dev/null || true)"
    if [ "$local_flag" = "true" ]; then HOSTED="${HOSTED:+$HOSTED, }$(node_label "$n")"; fi
  done
  printf '  hosted on (as seen by the nodes): %s   hosting threshold: %s of %s\n' "${HOSTED:-none reachable}" "$HOSTING_THRESHOLD" "$(printf '%s' "$NODE_IDS" | wc -w | tr -d ' ')"
  printf '  GovernanceRules: %s\n' "$(state_get '.rules_cid' | cut -c1-24)..."
  printf '  TreasuryCharter: %s\n' "$(state_get '.charter.cid' | cut -c1-24)..."
  printf '  DSO party:       %s\n' "$(state_get '.dso_party')"
fi
for n in $NODE_IDS; do
  if [ "$(state_get ".nodes[\"$n\"].offline")" = "true" ]; then
    printf '\nNote: node %s was taken offline with scripts/localnet-node.sh (bring it back with: scripts/localnet-node.sh %s online).\n' "$(node_label "$n")" "$n"
  fi
done
printf '\n'
exit $FAIL
