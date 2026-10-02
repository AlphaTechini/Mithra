#!/usr/bin/env bash
# Shared helpers for the LocalNet scripts (scripts/localnet-*.sh). Source this file, do not run it.
# Portable to macOS bash 3.2: no associative arrays, no mapfile, no ${var,,}.
#
# Provides: logging, need_cmd, version_ge, wait_for, jwt_unsafe, ledger_curl, dm_curl, validator_curl,
# node_* accessors for localnet/nodes.env, state file helpers (localnet/.state/state.json) and the
# docker compose wrappers. With DRY_RUN=1 every HTTP request is printed instead of sent (see dryrun.sh).

# shellcheck shell=bash disable=SC2034,SC2119,SC2120,SC2153

MITHRA_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOCALNET_ROOT="$MITHRA_ROOT/localnet"
CACHE_DIR="$LOCALNET_ROOT/.cache"
DATA_DIR="$LOCALNET_ROOT/.data"
STATE_DIR="$LOCALNET_ROOT/.state"
STATE_FILE="${STATE_FILE:-$STATE_DIR/state.json}"
DRY_RUN="${DRY_RUN:-0}"
DRY_DIR="${DRY_DIR:-}"
LOCALNET_PROJECT="${LOCALNET_PROJECT:-localnet}"

# ---------------------------------------------------------------------------------------------------
# Logging. Never call these inside $( ) that is meant to return a value.
# ---------------------------------------------------------------------------------------------------
log_info() { printf '%s\n' "$*"; }
log_step() { printf '\n== %s\n' "$*"; }
log_ok() { printf '\xe2\x9c\x93 %s\n' "$*"; }
log_skip() { printf '\xe2\x9c\x93 %s (already done)\n' "$*"; }
log_warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

# print_usage <script>: the leading comment block of a script (after the shebang), without "# ".
print_usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$1"; }

is_dry() { [ "$DRY_RUN" = "1" ]; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command '$1' not found on PATH. $2"
}

# version_ge A B: true when dotted version A >= B (numeric parts only).
version_ge() {
  local a1 a2 a3 b1 b2 b3
  IFS=. read -r a1 a2 a3 <<EOF
$1
EOF
  IFS=. read -r b1 b2 b3 <<EOF
$2
EOF
  a1=${a1:-0}; a2=${a2:-0}; a3=${a3:-0}; b1=${b1:-0}; b2=${b2:-0}; b3=${b3:-0}
  # strip non-digits (for example "-desktop")
  a1=${a1//[!0-9]/}; a2=${a2//[!0-9]/}; a3=${a3//[!0-9]/}
  if [ "$a1" -ne "$b1" ]; then [ "$a1" -gt "$b1" ]; return; fi
  if [ "$a2" -ne "$b2" ]; then [ "$a2" -gt "$b2" ]; return; fi
  [ "$a3" -ge "$b3" ]
}

# ---------------------------------------------------------------------------------------------------
# Configuration: localnet/versions.env and localnet/nodes.env are the only source of endpoints.
# ---------------------------------------------------------------------------------------------------
load_config() {
  [ -f "$LOCALNET_ROOT/versions.env" ] || die "missing $LOCALNET_ROOT/versions.env"
  [ -f "$LOCALNET_ROOT/nodes.env" ] || die "missing $LOCALNET_ROOT/nodes.env"
  set -a
  # shellcheck source=/dev/null
  . "$LOCALNET_ROOT/versions.env"
  # shellcheck source=/dev/null
  . "$LOCALNET_ROOT/nodes.env"
  set +a
  IMAGE_TAG="$SPLICE_VERSION"
  # MITHRA_SPLICE_DIR: use an already extracted bundle (splice-node/) instead of the cached download.
  if [ -n "${MITHRA_SPLICE_DIR:-}" ]; then
    LOCALNET_DIR="$MITHRA_SPLICE_DIR/docker-compose/localnet"
  else
    LOCALNET_DIR="$CACHE_DIR/splice-node/docker-compose/localnet"
  fi
  export IMAGE_TAG LOCALNET_DIR
  CONSOLE_DIR="$LOCALNET_ROOT/console"
  LEDGER_TOKEN="$(jwt_unsafe)"
}

node_upper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]'; }

# node_get <id> <FIELD>: value of NODE_<ID>_<FIELD> from nodes.env (dies when unset).
node_get() {
  local var
  var="NODE_$(node_upper "$1")_$2"
  if [ -z "${!var+x}" ]; then die "nodes.env has no $var"; fi
  printf '%s' "${!var}"
}

node_json_url() { printf 'http://%s:%s' "$LOCALNET_HOST" "$(node_get "$1" JSON_PORT)"; }
node_decman_url() { printf 'http://%s:%s' "$LOCALNET_HOST" "$(node_get "$1" DECMAN_PORT)"; }
registry_url() { printf 'http://%s:%s/api/validator/v0/scan-proxy' "$LOCALNET_HOST" "$REGISTRY_PORT"; }
node_label() { printf '%s' "$(node_upper "$1")"; }

# ---------------------------------------------------------------------------------------------------
# JWT (HS256, secret "unsafe"): no node dependency, only openssl and jq.
# ---------------------------------------------------------------------------------------------------
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# jwt_unsafe [sub] [aud] [secret]: prints a HS256 JWT with claims {"aud","sub"}.
jwt_unsafe() {
  local sub="${1:-${LEDGER_USER_ID:-ledger-api-user}}"
  local aud="${2:-${LEDGER_AUDIENCE:-https://canton.network.global}}"
  local secret="${3:-${LEDGER_HMAC_SECRET:-unsafe}}"
  local header payload sig
  header="$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)"
  payload="$(printf '%s' "$(jq -cn --arg sub "$sub" --arg aud "$aud" '{aud:$aud,sub:$sub}')" | b64url)"
  sig="$(printf '%s' "$header.$payload" | openssl dgst -sha256 -hmac "$secret" -binary | b64url)"
  printf '%s.%s.%s' "$header" "$payload" "$sig"
}

# ---------------------------------------------------------------------------------------------------
# HTTP. Prints the response body on stdout. Returns 0 for 2xx; otherwise prints the status and the
# start of the body on stderr and returns 22 (curl failures return 7). With DRY_RUN=1 nothing is sent:
# the request is printed on stderr and a canned response comes from dryrun.sh.
# ---------------------------------------------------------------------------------------------------
# Trace lines go to fd 3 (a copy of the original stderr, opened by open_trace_fd) so that they are never
# captured by callers that read a function's output with 2>&1.
open_trace_fd() { exec 3>&2; }

trace_request() { # method url body
  local shown=""
  if [ -n "${3:-}" ]; then
    shown="$(printf '%s' "$3" | jq -c 'walk(if type == "string" and length > 120 then .[0:40] + "...(" + (length | tostring) + " chars)" else . end)' 2>/dev/null)" || shown="$3"
  fi
  if [ -n "$shown" ]; then
    printf '  HTTP %s %s\n       body: %s\n' "$1" "$2" "$shown" >&3
  else
    printf '  HTTP %s %s\n' "$1" "$2" >&3
  fi
}

# http_call <token> <base-url> <method> <path> [body]
http_call() {
  local token="$1" base="$2" method="$3" path="$4" body="${5:-}"
  local url="$base$path"
  if is_dry; then
    trace_request "$method" "$url" "$body"
    dry_response "$method" "$base" "$path" "$body"
    return 0
  fi
  if [ "${LOCALNET_TRACE:-0}" = "1" ]; then trace_request "$method" "$url" "$body"; fi
  local out bodyfile status
  out="$(mktemp "${TMPDIR:-/tmp}/mithra-http.XXXXXX")"
  bodyfile="$(mktemp "${TMPDIR:-/tmp}/mithra-body.XXXXXX")"
  printf '%s' "$body" >"$bodyfile"
  local args=(-sS --max-time "${HTTP_TIMEOUT:-120}" -o "$out" -w '%{http_code}' -X "$method" -H 'Accept: application/json')
  if [ -n "$token" ]; then args+=(-H "Authorization: Bearer $token"); fi
  if [ -n "$body" ]; then args+=(-H 'Content-Type: application/json' --data-binary "@$bodyfile"); fi
  if ! status="$(curl "${args[@]}" "$url")"; then
    rm -f "$out" "$bodyfile"
    printf 'curl failed: %s %s\n' "$method" "$url" >&2
    return 7
  fi
  cat "$out"
  local rc=0
  case "$status" in
    2??) ;;
    *)
      printf 'HTTP %s from %s %s: %s\n' "$status" "$method" "$url" "$(head -c 600 "$out")" >&2
      rc=22
      ;;
  esac
  rm -f "$out" "$bodyfile"
  return $rc
}

# ledger_curl <node> <method> <path> [body]: JSON Ledger API of a node (authenticated).
ledger_curl() {
  local n="$1"
  shift
  http_call "$LEDGER_TOKEN" "$(node_json_url "$n")" "$@"
}

# dm_curl <node> <method> <path> [body]: that node's Decentralization Manager.
dm_curl() {
  local n="$1"
  shift
  http_call "" "$(node_decman_url "$n")" "$@"
}

# validator_curl <method> <path> [body]: the app-provider validator (scan proxy), authenticated.
validator_curl() {
  http_call "$LEDGER_TOKEN" "http://$LOCALNET_HOST:$REGISTRY_PORT" "$@"
}

# urlenc <string>: percent-encode for a URL path segment or query value.
urlenc() { jq -rn --arg v "$1" '$v|@uri'; }

# ---------------------------------------------------------------------------------------------------
# Waiting. wait_for <description> <timeout-seconds> <interval-seconds> <command...>
# The command succeeds (0) when ready, returns 2 for a fatal error, anything else means "not yet".
# Its stdout+stderr are kept; on success the stdout is left in WAIT_RESULT, on timeout the last output
# is part of the error. In dry-run the command is called once and assumed ready.
# ---------------------------------------------------------------------------------------------------
WAIT_RESULT=""
wait_for() {
  local desc="$1" timeout="$2" interval="$3"
  shift 3
  if is_dry; then
    WAIT_RESULT="$("$@")" || true
    return 0
  fi
  local start=$SECONDS out rc=0
  while :; do
    rc=0
    out="$("$@" 2>&1)" || rc=$?
    if [ "$rc" -eq 0 ]; then
      WAIT_RESULT="$out"
      return 0
    fi
    if [ "$rc" -eq 2 ]; then
      die "$desc: failed. Last response: $(printf '%s' "$out" | head -c 800)"
    fi
    if [ $((SECONDS - start)) -ge "$timeout" ]; then
      die "$desc: still not ready after ${timeout}s. Last response: $(printf '%s' "$out" | head -c 800)"
    fi
    sleep "$interval"
  done
}

# ---------------------------------------------------------------------------------------------------
# State (localnet/.state/state.json). In dry-run the file lives in a temp dir.
# ---------------------------------------------------------------------------------------------------
state_init() {
  mkdir -p "$(dirname "$STATE_FILE")"
  [ -f "$STATE_FILE" ] || printf '{}\n' >"$STATE_FILE"
}

# state_get <jq-path>: the value as a raw string, empty when absent or false/null.
state_get() { jq -r "$1 // empty" "$STATE_FILE"; }

# state_set <jq-path> <json-value>
state_set() {
  local tmp
  tmp="$(mktemp "$STATE_FILE.XXXXXX")"
  jq --argjson v "$2" "$1 = \$v" "$STATE_FILE" >"$tmp" && mv "$tmp" "$STATE_FILE"
}

# state_set_str <jq-path> <string>
state_set_str() { state_set "$1" "$(jq -n --arg v "$2" '$v')"; }

step_done() { [ "$(state_get ".steps[\"$1\"]")" = "true" ]; }
step_mark() { state_set ".steps[\"$1\"]" true; }

# once <key> <command...>: run once per state file (marks the key when the command succeeds).
once() {
  local key="$1"
  shift
  if step_done "$key"; then return 0; fi
  "$@"
  step_mark "$key"
}

# ---------------------------------------------------------------------------------------------------
# Docker compose wrappers
# ---------------------------------------------------------------------------------------------------
# localnet_compose <compose args...>: the Splice LocalNet project (verified command from the bundle docs).
localnet_compose() {
  docker compose -p "$LOCALNET_PROJECT" \
    --env-file "$LOCALNET_DIR/compose.env" --env-file "$LOCALNET_DIR/env/common.env" \
    -f "$LOCALNET_DIR/compose.yaml" -f "$LOCALNET_DIR/resource-constraints.yaml" "$@"
}

# localnet_console_compose <compose args...>: the same project plus Mithra's console override, with every
# profile enabled. All profiles are needed: the bundle's multi-sync-startup service extends `console` and
# depends on `splice`, so `--profile console` alone is rejected ("depends on undefined service splice").
localnet_console_compose() {
  MITHRA_CONSOLE_DIR="$CONSOLE_DIR" docker compose -p "$LOCALNET_PROJECT" \
    --env-file "$LOCALNET_DIR/compose.env" --env-file "$LOCALNET_DIR/env/common.env" \
    -f "$LOCALNET_DIR/compose.yaml" -f "$LOCALNET_DIR/resource-constraints.yaml" \
    -f "$LOCALNET_ROOT/compose.console.yaml" \
    --profile sv --profile app-provider --profile app-user --profile console "$@"
}

# decman_compose <compose args...>: the three DecMan instances.
decman_compose() {
  docker compose --project-directory "$LOCALNET_ROOT" \
    --env-file "$LOCALNET_ROOT/versions.env" --env-file "$LOCALNET_ROOT/nodes.env" \
    -f "$LOCALNET_ROOT/compose.decman.yaml" "$@"
}

# run_cmd <command...>: run a command, or only print it in dry-run.
run_cmd() {
  if is_dry; then
    printf '  [dry-run] would run: %s\n' "$*" >&3
    return 0
  fi
  "$@"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# ---------------------------------------------------------------------------------------------------
# Ledger helpers shared by the scripts
# ---------------------------------------------------------------------------------------------------
# ledger_find_party <node> <hint>: the full party id of an allocated hint, empty when none.
ledger_find_party() {
  local out
  out="$(ledger_curl "$1" GET /v2/parties)" || return 1
  printf '%s' "$out" | jq -r --arg p "$2::" '[.partyDetails[]? | .party | select(startswith($p))][0] // empty'
}

# ledger_ensure_party <node> <hint>: prints the party id, allocating the party if it does not exist.
ledger_ensure_party() {
  local n="$1" hint="$2" party out
  party="$(ledger_find_party "$n" "$hint")" || return 1
  if [ -z "$party" ]; then
    out="$(ledger_curl "$n" POST /v2/parties "$(jq -cn --arg h "$hint" '{partyIdHint:$h,identityProviderId:""}')")" || return 1
    party="$(printf '%s' "$out" | jq -r '.partyDetails.party // empty')"
    [ -n "$party" ] || {
      printf 'allocating party %s on node %s returned no party: %s\n' "$hint" "$n" "$out" >&2
      return 1
    }
  fi
  printf '%s' "$party"
}

# ledger_grant_rights <node> <actAs|readAs> <party...>: grant LEDGER_USER_ID rights (idempotent).
# Verify on the owner's machine: JSON API v2 GrantUserRightsRequest {userId, rights[{kind:{CanActAs:{value:{party}}}}]}.
ledger_grant_rights() {
  local n="$1" mode="$2" body
  shift 2
  body="$(jq -cn --arg u "$LEDGER_USER_ID" --arg mode "$mode" '
    ($ARGS.positional | map(
        if $mode == "actAs" then [{kind: {CanActAs: {value: {party: .}}}}, {kind: {CanReadAs: {value: {party: .}}}}]
        else [{kind: {CanReadAs: {value: {party: .}}}}] end
      ) | add) as $rights
    | {userId: $u, identityProviderId: "", rights: $rights}' --args "$@")"
  ledger_curl "$n" POST "/v2/users/$(urlenc "$LEDGER_USER_ID")/rights" "$body" >/dev/null
}

# ledger_active_cids <node> <party> <template-id>: contract ids of active contracts visible to the party.
ledger_active_cids() {
  local n="$1" party="$2" tpl="$3" end offset body out
  end="$(ledger_curl "$n" GET /v2/state/ledger-end)" || return 1
  offset="$(printf '%s' "$end" | jq -c '.offset')"
  body="$(jq -cn --argjson o "$offset" --arg p "$party" --arg t "$tpl" '{
    activeAtOffset: $o,
    eventFormat: {filtersByParty: {($p): {cumulative: [{identifierFilter: {TemplateFilter: {value: {templateId: $t, includeCreatedEventBlob: false}}}}]}}, verbose: false}
  }')"
  out="$(ledger_curl "$n" POST /v2/state/active-contracts "$body")" || return 1
  printf '%s' "$out" | jq -r '.[]? | .contractEntry.JsActiveContract.createdEvent.contractId // empty'
}

# shellcheck source=scripts/lib/dryrun.sh
. "$(dirname "${BASH_SOURCE[0]}")/dryrun.sh"
