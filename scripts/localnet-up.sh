#!/usr/bin/env bash
# One command from a clean machine with Docker to the Mithra LocalNet:
#   three participants (Splice LocalNet), three BitSafe Decentralization Manager instances, the
#   Decentralized Party mithra-treasury (hosted on all three nodes, threshold 2), the Mithra DAR vetted
#   on all three nodes, GovernanceRules with the Mithra operator allowed to propose, the demo parties,
#   and a TreasuryCharter created through a governed action (2 of 3 node confirmations).
# Writes localnet/.state/localnet.env with every id and endpoint the backend needs.
#
#   scripts/localnet-up.sh             run (idempotent: finished steps print "already done")
#   scripts/localnet-up.sh --dry-run   print every HTTP request a fresh run would make, call no Docker
#
# Settings: localnet/versions.env (versions) and localnet/nodes.env (nodes, ports, operators).
# Needs: docker with compose >= 2.24, jq, curl, openssl, base64, tar; about 8 GB of memory for Docker.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

MIN_COMPOSE_VERSION="2.24.0" # the bundle's compose.yaml uses env_file `required: false`
CURRENT_STEP="starting"

usage() {
  print_usage "${BASH_SOURCE[0]}"
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown argument: $arg"
      ;;
  esac
done

on_exit() {
  local rc=$?
  if is_dry; then dry_cleanup; fi
  if [ "$rc" -ne 0 ]; then
    printf '\nLocalNet bring-up failed during: %s (exit %s).\nFix the problem and run scripts/localnet-up.sh again, finished steps are skipped.\n' "$CURRENT_STEP" "$rc" >&2
  fi
}
trap on_exit EXIT

# ---------------------------------------------------------------------------------------------------
# Static tables
# ---------------------------------------------------------------------------------------------------
# Demo parties, all on node A (so that taking node B offline never affects a payee): hint|display name.
# The operator and the agent are infrastructure parties and are not sign-in personas.
INFRA_HINTS="mithra-operator mithra-agent"
PERSONAS="treasurer|Treasurer
approver-1|Approver 1
approver-2|Approver 2
approver-3|Approver 3
holder-a|Holder A
holder-b|Holder B
holder-c|Holder C
holder-d|Holder D
auditor|Auditor"

DAR_GOV_ACTION="$MITHRA_ROOT/daml/dars/governance-action-v1-0.1.0.dar"
DAR_GOV_CORE="$MITHRA_ROOT/daml/dars/governance-core-v1-0.1.0.dar"
DAR_MITHRA="$MITHRA_ROOT/daml/mithra/.daml/dist/mithra-v1-0.1.0.dar"

TPL_CHARTER="#mithra-v1:Mithra.Charter:TreasuryCharter"
TPL_CHARTER_PROPOSAL="#mithra-v1:Mithra.Governance:CharterProposal"

short_party() { # mithra-treasury::1220abcd... -> mithra-treasury::1220abcd...
  local p="$1"
  case "$p" in
    *::*) printf '%s::%s...' "${p%%::*}" "$(printf '%s' "${p#*::}" | cut -c1-8)" ;;
    *) printf '%s' "$p" ;;
  esac
}

node_list_text() { # "A, B, C"
  local n out=""
  for n in $NODE_IDS; do out="${out:+$out, }$(node_label "$n")"; done
  printf '%s' "$out"
}

# Nodes whose operators confirm governed actions automatically (autoConfirm), first GOVERNANCE_THRESHOLD of them.
confirming_nodes() {
  local n count=0 out=""
  for n in $NODE_IDS; do
    if [ "$(node_get "$n" AUTO_CONFIRM)" = "true" ] && [ "$count" -lt "$GOVERNANCE_THRESHOLD" ]; then
      out="$out $n"
      count=$((count + 1))
    fi
  done
  [ "$count" -ge "$GOVERNANCE_THRESHOLD" ] || die "nodes.env: need at least $GOVERNANCE_THRESHOLD nodes with NODE_x_AUTO_CONFIRM=true to run the governed actions"
  printf '%s' "${out# }"
}

# ---------------------------------------------------------------------------------------------------
# Step 1: prerequisites
# ---------------------------------------------------------------------------------------------------
check_prerequisites() {
  CURRENT_STEP="prerequisites"
  need_cmd jq "Install it (brew install jq / apt-get install jq)."
  need_cmd curl "Install curl."
  need_cmd openssl "Install openssl."
  need_cmd base64 "Install coreutils base64."
  need_cmd tar "Install tar."
  if is_dry; then
    log_ok "Prerequisites (dry-run: Docker not checked)"
    return 0
  fi
  need_cmd docker "Install Docker Desktop or Docker Engine with the compose plugin."
  local v mem
  v="$(docker compose version --short 2>/dev/null || true)"
  [ -n "$v" ] || die "'docker compose' is not available. Install the Docker compose plugin (v$MIN_COMPOSE_VERSION or newer)."
  version_ge "${v#v}" "$MIN_COMPOSE_VERSION" || die "docker compose $v is too old, need $MIN_COMPOSE_VERSION or newer (the LocalNet compose file uses env_file 'required: false')."
  docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon. Start Docker and try again."
  mem="$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)"
  if [ "${mem:-0}" -lt 7500000000 ] 2>/dev/null; then
    log_warn "Docker has only $((mem / 1024 / 1024)) MiB of memory; LocalNet needs about 8 GB. Raise it in Docker Desktop settings if containers get killed."
  fi
  log_ok "Prerequisites (docker compose $v, jq, curl, openssl)"
}

# ---------------------------------------------------------------------------------------------------
# Step 2: Splice bundle
# ---------------------------------------------------------------------------------------------------
ensure_bundle() {
  CURRENT_STEP="Splice LocalNet bundle"
  local tarball marker got
  marker="$CACHE_DIR/.bundle-$SPLICE_VERSION.verified"
  if [ -n "${MITHRA_SPLICE_DIR:-}" ]; then
    [ -f "$LOCALNET_DIR/compose.yaml" ] || die "MITHRA_SPLICE_DIR=$MITHRA_SPLICE_DIR has no docker-compose/localnet/compose.yaml"
    log_skip "Splice LocalNet bundle (using MITHRA_SPLICE_DIR=$MITHRA_SPLICE_DIR)"
    return 0
  fi
  if is_dry; then
    log_info "  [dry-run] would download $SPLICE_BUNDLE_URL, verify SHA-256 $SPLICE_BUNDLE_SHA256 and extract docker-compose/ into $CACHE_DIR"
    return 0
  fi
  if [ -f "$marker" ] && [ -f "$LOCALNET_DIR/compose.yaml" ]; then
    log_skip "Splice LocalNet bundle $SPLICE_VERSION in localnet/.cache"
    return 0
  fi
  mkdir -p "$CACHE_DIR"
  tarball="$CACHE_DIR/${SPLICE_VERSION}_splice-node.tar.gz"
  if [ ! -f "$tarball" ]; then
    log_info "Downloading the Splice $SPLICE_VERSION bundle (about 760 MB) ..."
    curl -fL --retry 3 --retry-delay 5 -C - -o "$tarball.part" "$SPLICE_BUNDLE_URL" || die "download of $SPLICE_BUNDLE_URL failed"
    mv "$tarball.part" "$tarball"
  fi
  got="$(sha256_of "$tarball")"
  if [ "$got" != "$SPLICE_BUNDLE_SHA256" ]; then
    rm -f "$tarball"
    die "SHA-256 of the Splice bundle does not match. expected $SPLICE_BUNDLE_SHA256 got $got. The file was deleted; rerun to download it again."
  fi
  log_info "Extracting the LocalNet compose files ..."
  rm -rf "$CACHE_DIR/splice-node"
  tar -xzf "$tarball" -C "$CACHE_DIR" splice-node/docker-compose || die "could not extract $tarball"
  [ -f "$LOCALNET_DIR/compose.yaml" ] || die "bundle has no docker-compose/localnet/compose.yaml"
  : >"$marker"
  log_ok "Splice LocalNet bundle $SPLICE_VERSION downloaded, SHA-256 verified, extracted to localnet/.cache"
}

# ---------------------------------------------------------------------------------------------------
# Step 3: LocalNet containers
# ---------------------------------------------------------------------------------------------------
localnet_healthy() {
  local c s
  for c in canton splice; do
    s="$(docker inspect -f '{{.State.Health.Status}}' "$c" 2>/dev/null)" || return 1
    [ "$s" = "healthy" ] || return 1
  done
}

json_api_ready() { # node
  local out
  out="$(ledger_curl "$1" GET /v2/version 2>&1)" || {
    printf '%s' "$out"
    return 1
  }
  printf '%s' "$out" | jq -r '.version // empty'
}

start_localnet() {
  CURRENT_STEP="LocalNet containers"
  local n was_up=0
  if ! is_dry && localnet_healthy; then was_up=1; fi
  if [ "$was_up" -eq 0 ]; then
    log_info "Starting LocalNet (first start pulls images, this can take several minutes) ..."
    run_cmd localnet_compose --profile sv --profile app-provider --profile app-user up -d --wait --wait-timeout 1200 ||
      die "docker compose up failed. If an image could not be pulled, check your network access to ghcr.io."
  fi
  for n in $NODE_IDS; do
    wait_for "JSON Ledger API of node $(node_label "$n") ($(node_json_url "$n"))" 300 5 json_api_ready "$n"
  done
  if [ "$was_up" -eq 1 ]; then
    log_skip "LocalNet running: 3 participants (app-provider, app-user, sv), validators, synchronizer"
  else
    log_ok "LocalNet running: 3 participants (app-provider, app-user, sv), validators, synchronizer"
  fi
  if ! is_dry; then
    docker network inspect "$DOCKER_NETWORK" >/dev/null 2>&1 || die "docker network '$DOCKER_NETWORK' does not exist; DecMan cannot join it. Check DOCKER_NETWORK in localnet/nodes.env."
  fi
}

# A state file that names a treasury party the ledger does not know means LocalNet was reset behind our back.
verify_state_matches_ledger() {
  local t out
  t="$(state_get '.treasury.party')"
  [ -n "$t" ] || return 0
  if is_dry; then return 0; fi
  if ! out="$(ledger_curl a GET "/v2/parties/$(urlenc "$t")" 2>&1)"; then
    die "localnet/.state/state.json names the treasury party $t but node A does not know it. LocalNet was probably wiped (docker compose down -v). Run scripts/localnet-down.sh --reset and then this script again. Response: $out"
  fi
}

# ---------------------------------------------------------------------------------------------------
# Step 4: Mithra DAR
# ---------------------------------------------------------------------------------------------------
ensure_mithra_dar() {
  CURRENT_STEP="Mithra DAR build"
  local f
  for f in "$DAR_GOV_ACTION" "$DAR_GOV_CORE"; do
    [ -f "$f" ] || die "vendored BitSafe DAR missing: $f"
  done
  if [ -f "$DAR_MITHRA" ]; then
    log_skip "Mithra DAR daml/mithra/.daml/dist/mithra-v1-0.1.0.dar"
    return 0
  fi
  if is_dry; then
    log_info "  [dry-run] would run: scripts/daml.sh build"
    return 0
  fi
  log_info "Building the Mithra DAR (scripts/daml.sh build) ..."
  "$SCRIPT_DIR/daml.sh" build || die "scripts/daml.sh build failed"
  [ -f "$DAR_MITHRA" ] || die "scripts/daml.sh build did not produce $DAR_MITHRA"
  log_ok "Mithra DAR built: daml/mithra/.daml/dist/mithra-v1-0.1.0.dar"
}

# ---------------------------------------------------------------------------------------------------
# Step 5: DecMan instances
# ---------------------------------------------------------------------------------------------------
decman_ready() { # node: node-config answers and the Noise key exists
  local cfg keys
  cfg="$(dm_curl "$1" GET /node-config 2>&1)" || {
    printf '%s' "$cfg"
    return 1
  }
  keys="$(dm_curl "$1" GET /keys/status 2>&1)" || {
    printf '%s' "$keys"
    return 1
  }
  if [ -z "$(printf '%s' "$keys" | jq -r '.public_key // empty')" ]; then
    printf 'no public_key yet: %s' "$keys"
    return 1
  fi
}

wait_decman_ready() {
  local n
  for n in $NODE_IDS; do
    wait_for "DecMan $(node_label "$n") ($(node_decman_url "$n"))" 180 3 decman_ready "$n"
  done
}

decman_running() {
  local n
  for n in $NODE_IDS; do
    [ "$(docker inspect -f '{{.State.Running}}' "$(node_get "$n" DECMAN_CONTAINER)" 2>/dev/null)" = "true" ] || return 1
  done
}

start_decman() {
  CURRENT_STEP="DecMan instances"
  local n was_up=0
  for n in $NODE_IDS; do
    if ! is_dry; then
      mkdir -p "$DATA_DIR/dm-$n"
      chmod 0777 "$DATA_DIR/dm-$n" # the container user is not ours; DecMan writes its key and database here
    fi
  done
  if ! is_dry && decman_running; then was_up=1; fi
  if [ "$was_up" -eq 0 ]; then
    run_cmd decman_compose up -d || die "could not start DecMan. If the image cannot be pulled, check access to public.ecr.aws ($DECMAN_IMAGE)."
  fi
  wait_decman_ready
  if [ "$was_up" -eq 1 ]; then
    log_skip "DecMan running on each node ($(node_list_text))"
  else
    log_ok "DecMan running on each node ($(node_list_text))"
  fi
}

# ---------------------------------------------------------------------------------------------------
# Step 6: peer configuration
# ---------------------------------------------------------------------------------------------------
collect_decman_info() {
  local n cfg keys pid pkey
  for n in $NODE_IDS; do
    cfg="$(dm_curl "$n" GET /node-config)"
    keys="$(dm_curl "$n" GET /keys/status)"
    pid="$(printf '%s' "$cfg" | jq -r '.node.participant_id // empty')"
    pkey="$(printf '%s' "$keys" | jq -r '.public_key // empty')"
    [ -n "$pid" ] || die "DecMan $(node_label "$n"): /node-config has no .node.participant_id: $cfg"
    [ -n "$pkey" ] || die "DecMan $(node_label "$n"): /keys/status has no .public_key: $keys"
    state_set_str ".nodes[\"$n\"].participant_id" "$pid"
    state_set_str ".nodes[\"$n\"].public_key" "$pkey"
  done
}

node_pid() { state_get ".nodes[\"$1\"].participant_id"; }

peers_json() {
  local n peers='[]'
  for n in $NODE_IDS; do
    peers="$(printf '%s' "$peers" | jq -c \
      --arg pid "$(node_pid "$n")" \
      --arg name "$(node_get "$n" NAME) - $(node_get "$n" OPERATOR)" \
      --arg addr "$(node_get "$n" DECMAN_CONTAINER)" \
      --argjson port "$(node_get "$n" DECMAN_NOISE_PORT)" \
      --arg key "$(state_get ".nodes[\"$n\"].public_key")" \
      '. + [{participant_id: $pid, name: $name, address: $addr, port: $port, public_key: $key, party: null}]')"
  done
  printf '%s' "$peers"
}

configure_peers() {
  CURRENT_STEP="DecMan peer configuration"
  collect_decman_info
  if step_done network_config; then
    log_skip "DecMan peers configured (3 peers, instances restarted)"
    return 0
  fi
  local peers n
  peers="$(peers_json)"
  for n in $NODE_IDS; do
    dm_curl "$n" POST /network-config "$peers" >/dev/null
  done
  # Peer keys are read at startup, so the instances must restart.
  run_cmd decman_compose restart
  wait_decman_ready
  collect_decman_info
  step_mark network_config
  log_ok "DecMan peers configured: each instance knows all 3 peers, instances restarted"
}

# ---------------------------------------------------------------------------------------------------
# Invitations and status polling (DecMan)
# ---------------------------------------------------------------------------------------------------
# pending_invitation <node> <type>: prints the id (as JSON) of the first pending invitation of that type.
pending_invitation() {
  local out id
  out="$(dm_curl "$1" GET /invitations 2>&1)" || {
    printf '%s' "$out"
    return 1
  }
  id="$(printf '%s' "$out" | jq -c --arg t "$2" '[.invitations[]? | select((.invitation_type | tostring) == $t) | select((.status // "pending" | tostring | ascii_downcase) == "pending") | .id][0] // empty' 2>/dev/null)" || {
    printf 'unexpected /invitations response: %s' "$out"
    return 1
  }
  if [ -z "$id" ]; then
    printf 'no pending %s invitation yet: %s' "$2" "$out"
    return 1
  fi
  printf '%s' "$id"
}

accept_invitation() { # node type
  local id
  wait_for "$2 invitation on DecMan $(node_label "$1")" 240 3 pending_invitation "$1" "$2"
  id="$WAIT_RESULT"
  dm_curl "$1" POST /invitations/accept "$(jq -cn --argjson id "$id" '{id: $id}')" >/dev/null
}

# status_completed <node> <path>: 0 when .status is completed, 2 (fatal) when failed, 1 otherwise.
status_completed() {
  local out st
  out="$(dm_curl "$1" GET "$2" 2>&1)" || {
    printf '%s' "$out"
    return 1
  }
  st="$(printf '%s' "$out" | jq -r '(.status // .state // "") | (if type == "object" then (keys[0] // "") else tostring end) | ascii_downcase' 2>/dev/null)" || st=""
  case "$st" in
    completed | complete | done | success | succeeded) return 0 ;;
    failed | error | rejected)
      printf '%s' "$out"
      return 2
      ;;
    *)
      printf '%s' "$out"
      return 1
      ;;
  esac
}

# ---------------------------------------------------------------------------------------------------
# Step 7: the treasury Decentralized Party
# ---------------------------------------------------------------------------------------------------
dm_find_treasury() {
  local out
  out="$(dm_curl a GET /decentralized-parties)" || return 1
  printf '%s' "$out" | jq -r --arg p "$TREASURY_PARTY_HINT::" '[.. | strings | select(startswith($p))][0] // empty'
}

treasury_listed() {
  local p
  p="$(dm_find_treasury 2>&1)" || {
    printf '%s' "$p"
    return 1
  }
  [ -n "$p" ] || {
    printf 'party %s not listed yet' "$TREASURY_PARTY_HINT"
    return 1
  }
  printf '%s' "$p"
}

# DecMan A submits for the treasury (act-as); DecMan B and C read its governance contracts to confirm.
ledger_grant_treasury_rights() {
  local n
  ledger_grant_rights a actAs "$1"
  for n in $(printf '%s' "$NODE_IDS" | cut -d' ' -f2-); do
    ledger_grant_rights "$n" readAs "$1"
  done
}

create_treasury_party() {
  CURRENT_STEP="treasury Decentralized Party"
  local existing others peers_json_ids body n hosted=""
  existing="$(dm_find_treasury)"
  if [ -n "$existing" ]; then
    state_set_str '.treasury.party' "$existing"
    # An earlier run may have been interrupted after the party was created and before the grant.
    ledger_grant_treasury_rights "$existing"
    log_skip "Treasury party $(short_party "$existing") (hosted on $(node_list_text); threshold $HOSTING_THRESHOLD)"
    return 0
  fi
  if ! step_done onboarding_started; then
    peers_json_ids="$(jq -cn --arg b "$(node_pid b)" --arg c "$(node_pid c)" '[$b, $c]')"
    body="$(jq -cn --arg prefix "$TREASURY_PARTY_HINT" --argjson peers "$peers_json_ids" --argjson t "$HOSTING_THRESHOLD" '{party_id_prefix: $prefix, peer_ids: $peers, threshold: $t}')"
    dm_curl a POST /onboarding "$body" >/dev/null
    step_mark onboarding_started
  fi
  others="$(printf '%s' "$NODE_IDS" | cut -d' ' -f2-)"
  for n in $others; do
    accept_invitation "$n" Onboarding
  done
  wait_for "onboarding of $TREASURY_PARTY_HINT on DecMan A" 600 5 status_completed a /onboarding/status
  wait_for "$TREASURY_PARTY_HINT listed in DecMan A /decentralized-parties" 120 3 treasury_listed
  existing="$WAIT_RESULT"
  state_set_str '.treasury.party' "$existing"
  # Soft check: which nodes report the party as local (hosted).
  for n in $NODE_IDS; do
    if [ "$(ledger_curl "$n" GET "/v2/parties/$(urlenc "$existing")" 2>/dev/null | jq -r '(.partyDetails | if type == "array" then .[0] else . end).isLocal // false' 2>/dev/null)" = "true" ]; then
      hosted="${hosted:+$hosted, }$(node_label "$n")"
    fi
  done
  if [ "$hosted" != "$(node_list_text)" ] && ! is_dry; then
    log_warn "the ledger API reports the treasury party as local on: ${hosted:-no node}. Expected $(node_list_text). Check the hosting in DecMan (see docs/verification.md)."
  fi
  ledger_grant_treasury_rights "$existing"
  log_ok "Treasury party $(short_party "$existing") (hosted on $(node_list_text); threshold $HOSTING_THRESHOLD)"
}

treasury() { state_get '.treasury.party'; }

# ---------------------------------------------------------------------------------------------------
# Step 8: member parties (one per node) and DecMan party configuration
# ---------------------------------------------------------------------------------------------------
member_of() { state_get ".members[\"$1\"]"; }

configure_members() {
  CURRENT_STEP="member parties and DecMan party-config"
  local n m body new=0 T
  T="$(treasury)"
  for n in $NODE_IDS; do
    m="$(ledger_ensure_party "$n" "mithra-member-$n")"
    state_set_str ".members[\"$n\"]" "$m"
    if ! step_done "member_rights_$n"; then
      ledger_grant_rights "$n" actAs "$m"
      step_mark "member_rights_$n"
      new=1
    fi
    if ! step_done "party_config_$n"; then
      body="$(jq -cn --arg d "$T" --arg m "$m" --arg u "$LEDGER_USER_ID" \
        '{dec_party_id: $d, member_party_id: $m, user_id: $u, packages: {governance_action: "#governance-action-v1", governance_core: "#governance-core-v1"}}')"
      dm_curl "$n" PUT /party-config "$body" >/dev/null
      step_mark "party_config_$n"
      new=1
    fi
  done
  if [ "$new" -eq 0 ]; then
    log_skip "Member parties mithra-member-a/b/c with ledger-api-user rights and DecMan party-config"
  else
    log_ok "Member parties mithra-member-a/b/c allocated, ledger-api-user can act as them, DecMan party-config set on each node"
  fi
}

# ---------------------------------------------------------------------------------------------------
# Step 9: Mithra demo parties (all on node A)
# ---------------------------------------------------------------------------------------------------
demo_party() { state_get ".demo[\"$1\"]"; }

ensure_demo_parties() {
  CURRENT_STEP="Mithra demo parties"
  local hint p all="" before=0 count=0
  if step_done demo_parties; then before=1; fi
  for hint in $INFRA_HINTS $(printf '%s\n' "$PERSONAS" | cut -d'|' -f1); do
    p="$(ledger_ensure_party a "$hint")"
    state_set_str ".demo[\"$hint\"]" "$p"
    all="$all $p"
    count=$((count + 1))
  done
  if [ "$before" -eq 0 ]; then
    # shellcheck disable=SC2086
    ledger_grant_rights a actAs $all
    step_mark demo_parties
  fi
  if [ "$before" -eq 1 ]; then
    log_skip "Demo parties on node A ($count: operator, agent, treasurer, 3 approvers, 4 holders, auditor)"
  else
    log_ok "Demo parties on node A ($count: operator, agent, treasurer, 3 approvers, 4 holders, auditor), ledger-api-user can act as them"
  fi
}

# ---------------------------------------------------------------------------------------------------
# Step 10: DARs
# ---------------------------------------------------------------------------------------------------
dars_vetted_everywhere() {
  local n out
  for n in $NODE_IDS; do
    out="$(dm_curl "$n" GET /packages/vetted 2>/dev/null)" || return 1
    printf '%s' "$out" | jq -e '[.. | strings | select(test("mithra-v1"))] | length > 0' >/dev/null 2>&1 || return 1
  done
}

dar_distribute_body() {
  local tmpd peers
  tmpd="$(mktemp -d "${TMPDIR:-/tmp}/mithra-dars.XXXXXX")"
  if [ -f "$DAR_MITHRA" ]; then
    base64 <"$DAR_MITHRA" | tr -d '\n' >"$tmpd/mithra.b64"
  else
    printf 'UExBQ0VIT0xERVI=' >"$tmpd/mithra.b64" # dry-run placeholder when the DAR is not built
  fi
  base64 <"$DAR_GOV_ACTION" | tr -d '\n' >"$tmpd/action.b64"
  base64 <"$DAR_GOV_CORE" | tr -d '\n' >"$tmpd/core.b64"
  peers="$(jq -cn --arg b "$(node_pid b)" --arg c "$(node_pid c)" '[$b, $c]')"
  jq -cn --argjson peers "$peers" \
    --arg fa "$(basename "$DAR_GOV_ACTION")" --rawfile da "$tmpd/action.b64" \
    --arg fc "$(basename "$DAR_GOV_CORE")" --rawfile dc "$tmpd/core.b64" \
    --arg fm "$(basename "$DAR_MITHRA")" --rawfile dm "$tmpd/mithra.b64" \
    '{dar_files: [{filename: $fa, data: $da}, {filename: $fc, data: $dc}, {filename: $fm, data: $dm}], peer_ids: $peers}'
  rm -rf "$tmpd"
}

distribute_dars() {
  CURRENT_STEP="DAR distribution"
  local body n others
  if step_done dars_distributed; then
    log_skip "DARs governance-action, governance-core and mithra-v1 vetted on $(node_list_text)"
    return 0
  fi
  if ! is_dry && dars_vetted_everywhere; then
    step_mark dars_distributed
    log_skip "DARs governance-action, governance-core and mithra-v1 vetted on $(node_list_text)"
    return 0
  fi
  body="$(dar_distribute_body)"
  dm_curl a POST /dars/distribute "$body" >/dev/null
  others="$(printf '%s' "$NODE_IDS" | cut -d' ' -f2-)"
  for n in $others; do
    accept_invitation "$n" Dars
  done
  wait_for "DAR distribution on DecMan A" 600 5 status_completed a /dars/distribute/status
  step_mark dars_distributed
  log_ok "DARs governance-action-v1, governance-core-v1 and mithra-v1 distributed and vetted on $(node_list_text)"
}

# ---------------------------------------------------------------------------------------------------
# Step 11: GovernanceRules
# ---------------------------------------------------------------------------------------------------
rules_cid_from_state() {
  local out
  out="$(dm_curl a GET "/governance/state?party_id=$(urlenc "$(treasury)")" 2>/dev/null)" || return 0
  printf '%s' "$out" | jq -r '(.rules_contract_id // .rules_cid // .governance_rules_contract_id // ([.. | objects | select(has("contract_id")) | .contract_id][0]) // empty) | strings' 2>/dev/null || true
}

rules_listed() {
  local c
  c="$(rules_cid_from_state)"
  [ -n "$c" ] || {
    printf 'GovernanceRules not visible in /governance/state yet'
    return 1
  }
  printf '%s' "$c"
}

rules_body() {
  local members="" n
  for n in $NODE_IDS; do members="$members $(member_of "$n")"; done
  # shellcheck disable=SC2086
  jq -cn --arg dec "$(treasury)" --arg op "$(demo_party mithra-operator)" --argjson thr "$GOVERNANCE_THRESHOLD" \
    --arg pa "$(node_pid a)" --arg pb "$(node_pid b)" --arg pc "$(node_pid c)" \
    --arg ma "$(member_of a)" --arg mb "$(member_of b)" --arg mc "$(member_of c)" '
    {decentralized_party_id: $dec,
     participant_ids: [$pa, $pb, $pc],
     participant_parties: [$ma, $mb, $mc],
     operator_party: $op,
     contracts: [{
       id: "mithra-governance-rules",
       name: "GovernanceRules",
       package_id: "#governance-core-v1",
       module_name: "Governance.Rules",
       entity_name: "GovernanceRules",
       fields: [
         {type: "decentralized_party"},
         {type: "party_set", parties: [$ma, $mb, $mc]},
         {type: "int64", value: $thr},
         {type: "rel_time", microseconds: 1800000000},
         {type: "none"}
       ]}]}'
}

deploy_governance_rules() {
  CURRENT_STEP="GovernanceRules"
  local existing n others
  existing="$(rules_cid_from_state)"
  if [ -n "$existing" ]; then
    state_set_str '.rules_cid' "$existing"
    log_skip "GovernanceRules for the treasury ($(short_party "$existing"), confirmations needed: $GOVERNANCE_THRESHOLD of 3)"
    return 0
  fi
  # A failed deployment stays "failed" on DecMan A; start a new one instead of waiting on it.
  if step_done rules_started && { status_completed a /contracts/status >/dev/null; [ $? -eq 2 ]; }; then
    log_info "The last GovernanceRules deployment failed on DecMan A; starting it again."
    state_set '.steps["rules_started"]' false
  fi
  if ! step_done rules_started; then
    dm_curl a POST /contracts "$(rules_body)" >/dev/null
    step_mark rules_started
  fi
  others="$(printf '%s' "$NODE_IDS" | cut -d' ' -f2-)"
  for n in $others; do
    accept_invitation "$n" Contracts
  done
  wait_for "GovernanceRules deployment on DecMan A" 600 5 status_completed a /contracts/status
  wait_for "GovernanceRules contract id in DecMan A /governance/state" 120 3 rules_listed
  state_set_str '.rules_cid' "$WAIT_RESULT"
  log_ok "GovernanceRules deployed for the treasury ($(short_party "$WAIT_RESULT"), confirmations needed: $GOVERNANCE_THRESHOLD of 3)"
}

rules_cid() { state_get '.rules_cid'; }

# ---------------------------------------------------------------------------------------------------
# Governed actions (shared by steps 12 and 13)
# ---------------------------------------------------------------------------------------------------
# gov_confirmation_cids <node> <needle>: JSON array of confirmation contract ids of the action whose
# entry mentions <needle> (the additional proposer party, or the proposal contract id).
# Verify on the owner's machine: the exact shape of GET /governance/confirmations.
gov_confirmation_cids() {
  local out
  out="$(dm_curl "$1" GET "/governance/confirmations?party_id=$(urlenc "$(treasury)")" 2>&1)" || {
    printf '%s' "$out"
    return 1
  }
  printf '%s' "$out" | jq -c --arg n "$2" '
    [.. | objects | select((.confirmations? | type) == "array") | select(tostring | contains($n))
     | .confirmations[] | (if type == "object" then (.contract_id // .confirmation_cid // .cid // .id // empty) else . end)]
    | unique' 2>/dev/null || {
    printf 'unexpected /governance/confirmations response: %s' "$out"
    return 1
  }
}

confirmations_ready() { # node needle min
  local cids
  cids="$(gov_confirmation_cids "$1" "$2")" || {
    printf '%s' "$cids"
    return 1
  }
  if [ "$(printf '%s' "$cids" | jq 'length')" -lt "$3" ]; then
    printf 'only %s confirmations so far for %s: %s' "$(printf '%s' "$cids" | jq 'length')" "$2" "$cids"
    return 1
  fi
  printf '%s' "$cids"
}

# confirm_and_execute <key> <needle> <confirm-body> <extra-execute-json>
confirm_and_execute() {
  local key="$1" needle="$2" cbody="$3" extra="$4" n cids ebody
  for n in $(confirming_nodes); do
    once "${key}_confirm_$n" dm_curl "$n" POST /governance/confirm "$cbody" >/dev/null
  done
  wait_for "$GOVERNANCE_THRESHOLD confirmations for $key on DecMan A" 120 3 confirmations_ready a "$needle" "$GOVERNANCE_THRESHOLD"
  cids="$WAIT_RESULT"
  ebody="$(printf '%s' "$cbody" | jq -c --argjson c "$cids" --argjson x "$extra" '. + {confirmation_cids: $c} + $x')"
  dm_curl a POST /governance/execute "$ebody" >/dev/null
}

# ---------------------------------------------------------------------------------------------------
# Step 12: Mithra operator may propose governed actions
# ---------------------------------------------------------------------------------------------------
add_operator_proposer() {
  CURRENT_STEP="operator as additional proposer"
  local op body
  if step_done operator_proposer; then
    log_skip "Mithra operator allowed to propose governed actions"
    return 0
  fi
  op="$(demo_party mithra-operator)"
  body="$(jq -cn --arg p "$(treasury)" --arg r "$(rules_cid)" --arg op "$op" \
    '{party_id: $p, rules_contract_id: $r, action: {type: "governance_add_additional_proposer", additional_proposer: $op}, governance_type: "core_self"}')"
  confirm_and_execute operator_proposer "$op" "$body" '{}'
  step_mark operator_proposer
  log_ok "Mithra operator $(short_party "$op") allowed to propose governed actions ($GOVERNANCE_THRESHOLD confirmations)"
}

# ---------------------------------------------------------------------------------------------------
# Step 13: TreasuryCharter through a governed action
# ---------------------------------------------------------------------------------------------------
charter_listed() {
  local cids
  cids="$(ledger_active_cids a "$(demo_party treasurer)" "$TPL_CHARTER" 2>&1)" || {
    printf '%s' "$cids"
    return 1
  }
  [ -n "$cids" ] || {
    printf 'TreasuryCharter not visible to the treasurer yet'
    return 1
  }
  printf '%s' "$cids" | head -n1
}

create_charter() {
  CURRENT_STEP="TreasuryCharter (governed action)"
  local existing op pcid body resp
  existing="$(ledger_active_cids a "$(demo_party treasurer)" "$TPL_CHARTER" | head -n1)"
  if [ -n "$existing" ]; then
    log_skip "TreasuryCharter $(short_party "$existing") (created by a governed action)"
    return 0
  fi
  op="$(demo_party mithra-operator)"
  pcid="$(ledger_active_cids a "$op" "$TPL_CHARTER_PROPOSAL" | head -n1)"
  if [ -z "$pcid" ]; then
    body="$(jq -cn --arg id "mithra-charter-proposal-$(date +%s)" --arg u "$LEDGER_USER_ID" --arg op "$op" \
      --arg gov "$(treasury)" --arg tr "$(demo_party treasurer)" --arg ag "$(demo_party mithra-agent)" --arg t "$TPL_CHARTER_PROPOSAL" \
      '{commands: {commandId: $id, userId: $u, actAs: [$op], commands: [{CreateCommand: {templateId: $t, createArguments: {governanceParty: $gov, proposer: $op, treasurer: $tr, agent: $ag, operator: $op}}}]}}')"
    resp="$(ledger_curl a POST /v2/commands/submit-and-wait-for-transaction "$body")"
    pcid="$(printf '%s' "$resp" | jq -r '[.transaction.events[]? | .CreatedEvent? | select(. != null) | select(.templateId | endswith(":Mithra.Governance:CharterProposal")) | .contractId][0] // empty')"
    [ -n "$pcid" ] || die "CharterProposal was created but no contract id was found in the response: $resp"
  fi
  state_set_str '.charter.proposal_cid' "$pcid"
  # DecMan requires an action, but a core_domain confirmation only uses proposal_cid; the current
  # threshold makes the placeholder a no-op even if it were ever applied.
  body="$(jq -cn --arg p "$(treasury)" --arg r "$(rules_cid)" --arg pc "$pcid" --argjson thr "$GOVERNANCE_THRESHOLD" \
    '{party_id: $p, rules_contract_id: $r, action: {type: "governance_set_threshold", new_threshold: $thr}, governance_type: "core_domain", proposal_cid: $pc}')"
  confirm_and_execute charter "$pcid" "$body" '{"disclosed_contracts": []}'
  wait_for "TreasuryCharter visible to the treasurer on node A" 180 3 charter_listed
  state_set_str '.charter.cid' "$WAIT_RESULT"
  log_ok "TreasuryCharter $(short_party "$WAIT_RESULT") created through a governed action ($GOVERNANCE_THRESHOLD of 3 node confirmations)"
}

# ---------------------------------------------------------------------------------------------------
# Step 14: DSO party (the CC registry admin)
# ---------------------------------------------------------------------------------------------------
dso_from_validator() {
  local out dso
  out="$(validator_curl GET /api/validator/v0/scan-proxy/dso-party-id 2>&1)" || {
    printf '%s' "$out"
    return 1
  }
  dso="$(printf '%s' "$out" | jq -r '.dso_party_id // empty' 2>/dev/null)" || dso=""
  [ -n "$dso" ] || {
    printf 'no dso_party_id in: %s' "$out"
    return 1
  }
  printf '%s' "$dso"
}

# Fallback: the sv node's public Scan API (same path pattern without the scan-proxy prefix).
dso_from_scan() {
  local out dso
  out="$(curl -sS --max-time 20 -H "Host: scan.localhost:$SCAN_PORT" "http://$LOCALNET_HOST:$SCAN_PORT/api/scan/v0/dso-party-id" 2>&1)" || {
    printf '%s' "$out"
    return 1
  }
  dso="$(printf '%s' "$out" | jq -r '.dso_party_id // empty' 2>/dev/null)" || dso=""
  [ -n "$dso" ] || {
    printf 'no dso_party_id in: %s' "$out"
    return 1
  }
  printf '%s' "$dso"
}

dso_any() {
  dso_from_validator || dso_from_scan
}

read_dso_party() {
  CURRENT_STEP="DSO party id"
  local dso
  dso="$(state_get '.dso_party')"
  if [ -n "$dso" ]; then
    log_skip "DSO party $(short_party "$dso") (asset admin for CC)"
    return 0
  fi
  wait_for "DSO party id from the validator scan proxy ($(registry_url)/dso-party-id)" 300 5 dso_any
  state_set_str '.dso_party' "$WAIT_RESULT"
  log_ok "DSO party $(short_party "$WAIT_RESULT") (asset admin for CC)"
}

# ---------------------------------------------------------------------------------------------------
# Step 15: localnet.env
# ---------------------------------------------------------------------------------------------------
demo_parties_json() {
  local hint disp out='[]'
  while IFS='|' read -r hint disp; do
    [ -n "$hint" ] || continue
    out="$(printf '%s' "$out" | jq -c --arg p "$(demo_party "$hint")" --arg d "$disp" '. + [{partyId: $p, displayName: $d}]')"
  done <<EOF
$PERSONAS
EOF
  printf '%s' "$out"
}

nodes_json() {
  local n out='[]'
  for n in $NODE_IDS; do
    out="$(printf '%s' "$out" | jq -c \
      --arg id "$n" --arg name "$(node_get "$n" NAME)" --arg op "$(node_get "$n" OPERATOR)" \
      --arg api "$(node_json_url "$n")" --arg dm "$(node_decman_url "$n")" \
      --argjson auto "$([ "$(node_get "$n" AUTO_CONFIRM)" = "true" ] && echo true || echo false)" \
      '. + [{id: $id, name: $name, operator: $op, jsonApiUrl: $api, decmanUrl: $dm, autoConfirm: $auto}]')"
  done
  printf '%s' "$out"
}

members_json() {
  local n out='{}'
  for n in $NODE_IDS; do
    out="$(printf '%s' "$out" | jq -c --arg id "$n" --arg m "$(member_of "$n")" '. + {($id): $m}')"
  done
  printf '%s' "$out"
}

write_localnet_env() {
  CURRENT_STEP="writing localnet.env"
  local target
  if is_dry; then target="$DRY_DIR/localnet.env"; else target="$STATE_DIR/localnet.env"; fi
  mkdir -p "$(dirname "$target")"
  {
    printf '# Generated by scripts/localnet-up.sh. Merge into .env with scripts/localnet-env.sh.\n'
    printf 'NETWORK=localnet\n'
    printf 'LEDGER_JSON_API_URL=%s\n' "$(node_json_url a)"
    printf 'LEDGER_USER_ID=%s\n' "$LEDGER_USER_ID"
    printf 'LEDGER_AUTH_MODE=unsafe-hmac\n'
    printf 'LEDGER_HMAC_SECRET=%s\n' "$LEDGER_HMAC_SECRET"
    printf 'LEDGER_AUDIENCE=%s\n' "$LEDGER_AUDIENCE"
    printf 'TREASURY_PARTY=%s\n' "$(treasury)"
    printf 'AGENT_PARTY=%s\n' "$(demo_party mithra-agent)"
    printf 'OPERATOR_PARTY=%s\n' "$(demo_party mithra-operator)"
    printf 'ASSET_ADMIN_PARTY=%s\n' "$(state_get '.dso_party')"
    printf 'ASSET_ID=Amulet\n'
    printf 'ASSET_SYMBOL=CC\n'
    printf 'REGISTRY_URL=%s\n' "$(registry_url)"
    printf "LOCALNET_DEMO_PARTIES='%s'\n" "$(demo_parties_json)"
    printf "LOCALNET_NODES='%s'\n" "$(nodes_json)"
    printf 'LOCALNET_READ_AS_TREASURY=true\n'
    printf 'DECMAN_GOVERNANCE_THRESHOLD=%s\n' "$GOVERNANCE_THRESHOLD"
    printf 'DECMAN_GOVERNANCE_RULES_CID=%s\n' "$(rules_cid)"
    printf "DECMAN_MEMBER_PARTIES='%s'\n" "$(members_json)"
  } >"$target"
  if is_dry; then
    log_ok "localnet/.state/localnet.env would contain (placeholder ids):"
    sed 's/^/    /' "$target"
  else
    log_ok "Wrote localnet/.state/localnet.env"
  fi
}

# ---------------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------------
main() {
  if is_dry; then
    dry_init
    log_info "DRY RUN: no Docker command runs and no HTTP request is sent; ids below are placeholders."
  fi
  if [ "${LOCALNET_TRACE:-0}" = "1" ]; then open_trace_fd; fi
  check_prerequisites
  load_config
  state_init

  log_step "LocalNet"
  ensure_bundle
  start_localnet
  verify_state_matches_ledger
  ensure_mithra_dar

  log_step "BitSafe Decentralization Manager"
  start_decman
  configure_peers

  log_step "Treasury party and Mithra parties"
  create_treasury_party
  ensure_demo_parties
  configure_members

  log_step "Governance"
  distribute_dars
  deploy_governance_rules
  add_operator_proposer
  create_charter

  log_step "Backend configuration"
  read_dso_party
  write_localnet_env

  CURRENT_STEP="done"
  if is_dry; then
    log_info ""
    log_info "Dry run finished."
  else
    log_info ""
    log_info "LocalNet is ready. Next: scripts/localnet-env.sh   (merges localnet/.state/localnet.env into .env)"
    log_info "Check it: scripts/localnet-status.sh. DecMan UI: $(node_decman_url a)"
  fi
}

# Run only when executed, so tests can source this file and call single steps.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main
fi
