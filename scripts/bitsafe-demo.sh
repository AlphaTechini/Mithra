#!/usr/bin/env bash
# BitSafe evidence run (N8): the whole demonstration on a running LocalNet, against the running backend,
# written to a timestamped report in docs/bitsafe-evidence/.
#   scripts/bitsafe-demo.sh                      run everything (about 10 to 25 minutes)
#   scripts/bitsafe-demo.sh --dry-run            print every request, change nothing, write no report
#   scripts/bitsafe-demo.sh --cycle 2026-09      cycle for step 2 (default: the previous month)
#   scripts/bitsafe-demo.sh --below-cycle 2026-08 cycle for step 3 (default: the month before step 2's)
#   scripts/bitsafe-demo.sh --total 400          total for step 2, within the cap (default 400)
#   scripts/bitsafe-demo.sh --keep               leave the step 3 proposal and the step 4 cap change in place
#   scripts/bitsafe-demo.sh --backend-log FILE   copy the backend's "[mithra-ledger]" error lines into the report
#   scripts/bitsafe-demo.sh --url URL            backend (default http://localhost:8787, or MITHRA_URL)
# Steps: 1 baseline (3 of 3 nodes, the Decentralized Party's hosting and threshold from DecMan);
# 2 node B offline, a cycle inside the Mandate still pays; 3 nodes B and C offline (below the hosting
# threshold of 2), the app refuses clearly and safely, then recovers; 4 node B offline, a Mandate change
# (governed action) stays below its confirmation threshold and seals once B is back.
# Needs: a running LocalNet (scripts/localnet-up.sh, scripts/localnet-env.sh), the backend and its
# database running with the seeded demo history (pnpm seed:localnet), jq, curl, docker, and
# LOCALNET_DEMO_PASSWORD (environment or .env). WARNING: step 2 really pays test CC for one cycle and
# uses up that cycle id; step 3 takes node C offline, which stops all CC transfers until it is back.
# Run it on a LocalNet you can reset (scripts/localnet-down.sh --reset) before recording the demo.
# The script always brings nodes B and C back online when it exits, also after an error or Ctrl+C.
# Exit code: 0 when every claim passed, 1 otherwise.
# shellcheck disable=SC2317,SC2016 # functions are called through poll and the exit trap; backticks are report text
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

usage() { print_usage "${BASH_SOURCE[0]}"; }

# ---------------------------------------------------------------------------------------------------
# Options and settings (timeouts can be shortened through the environment for fake-service tests)
# ---------------------------------------------------------------------------------------------------
BASE_URL="${MITHRA_URL:-http://localhost:8787}"
CYCLE_A=""
CYCLE_B=""
TOTAL_A="${BITSAFE_TOTAL:-400}"
KEEP=0
BACKEND_LOG="${MITHRA_BACKEND_LOG:-}"
CYCLE_EXPLICIT=0
BELOW_EXPLICIT=0

INFRA_WAIT="${BITSAFE_INFRA_WAIT:-90}"           # infrastructure answers are cached for 30 s
CYCLE_WAIT="${BITSAFE_CYCLE_WAIT:-300}"          # a cycle to reach paid / proposed
BELOW_WAIT="${BITSAFE_BELOW_WAIT:-420}"          # a cycle below the threshold to fail (client retries and timeouts)
SEAL_OBSERVE="${BITSAFE_SEAL_OBSERVE:-60}"       # how long the seal is watched below its threshold
SEAL_WAIT="${BITSAFE_SEAL_WAIT:-240}"            # a seal to complete once the threshold can be met
POLL_INTERVAL="${BITSAFE_POLL_INTERVAL:-5}"
HTTP_TIMEOUT="${BITSAFE_HTTP_TIMEOUT:-120}"
NODE_CMD_TIMEOUT="${BITSAFE_NODE_CMD_TIMEOUT:-300}"

while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    --dry-run) DRY_RUN=1 ;;
    --keep) KEEP=1 ;;
    --cycle) CYCLE_A="${2:-}"; CYCLE_EXPLICIT=1; shift ;;
    --below-cycle) CYCLE_B="${2:-}"; BELOW_EXPLICIT=1; shift ;;
    --total) TOTAL_A="${2:-}"; shift ;;
    --backend-log) BACKEND_LOG="${2:-}"; shift ;;
    --url) BASE_URL="${2:-}"; shift ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
  shift
done
BASE_URL="${BASE_URL%/}"
for v in "$CYCLE_A" "$CYCLE_B"; do
  case "$v" in '' | [0-9][0-9][0-9][0-9]-[0-1][0-9]) ;; *) die "cycle ids look like 2026-09, got: $v" ;; esac
done
case "$TOTAL_A" in *[!0-9.]* | '') die "--total must be a plain decimal number, got: $TOTAL_A" ;; esac
export DRY_RUN

need_cmd jq "Install jq."
need_cmd curl "Install curl."
load_config

# The message the backend shows below the hosting threshold (apps/backend/src/ledger/errors.ts).
EXPECTED_MESSAGE="The treasury's nodes did not confirm in time. At least 2 of its 3 nodes must be online; check Settings › Infrastructure, then try again."
PROPOSED_RE='^(countdown|held|awaiting-approval|executing|paid-automatically|paid-after-approval|awaiting-acceptance|needs-funds)$'
PAID_RE='^(paid-automatically|awaiting-acceptance)$'

NODE_COUNT="$(printf '%s' "$NODE_IDS" | wc -w | tr -d ' ')"

# ---------------------------------------------------------------------------------------------------
# Work files, report pieces, results
# ---------------------------------------------------------------------------------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mithra-bitsafe.XXXXXX")"
BODY="$WORK/body.md"
RESULTS="$WORK/results.tsv"
JAR="$WORK/cookies.txt"
: >"$BODY"
: >"$RESULTS"
STAMP="$(date -u +%Y-%m-%dT%H%M)"
REPORT_DIR="$MITHRA_ROOT/docs/bitsafe-evidence"
REPORT="$REPORT_DIR/$STAMP.md"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
FINALIZED=0
B_OFF=0
C_OFF=0
DRY_DIR="${DRY_DIR:-}"

if is_dry; then
  dry_init
  exec 3>&1 # the plan goes to stdout
  : >"$DRY_DIR/onboarded"
  printf '1 5000.0000000000\n' >"$DRY_DIR/mandate"
else
  open_trace_fd
fi
MAIN_STARTED=0

rep() { printf '%s\n' "$*" >>"$BODY"; }
say() { printf '[bitsafe] %s\n' "$*"; }

# rep_block <lang>: stdin as a fenced block.
rep_block() {
  {
    printf '```%s\n' "$1"
    cat
    printf '\n```\n\n'
  } >>"$BODY"
}

# short <max-chars>: stdin cut to max chars with a marker.
short() {
  local max="${1:-700}" text
  text="$(cat)"
  if [ "${#text}" -gt "$max" ]; then printf '%s ...(trimmed, %s chars)' "${text:0:$max}" "${#text}"; else printf '%s' "$text"; fi
}

# jshort <max>: stdin JSON as one line, trimmed.
jshort() {
  local max="${1:-700}" text compact
  text="$(cat)"
  compact="$(printf '%s' "$text" | jq -c '.' 2>/dev/null)" || compact="$text"
  printf '%s' "$compact" | short "$max"
}

claim_text() {
  case "$1" in
    B1) printf 'The treasury party is a Decentralized Party hosted on nodes A, B and C with a hosting threshold of %s' "$HOSTING_THRESHOLD" ;;
    B2) printf 'All three nodes are online and the Infrastructure panel says so' ;;
    O1) printf 'With node B offline the Infrastructure panel says "Still running on 2 of 3 nodes"' ;;
    O2) printf 'With node B offline a cycle inside the Mandate still executes and pays' ;;
    T1) printf 'With nodes B and C offline the Infrastructure panel says "Below threshold: 1 of 3 nodes online"' ;;
    T2) printf 'Below the hosting threshold a cycle does not complete: no proposal, nothing paid' ;;
    T3) printf 'Below the hosting threshold the app shows the clear message and the cycle is failed' ;;
    T4) printf 'With the nodes back, the same cycle is retried and now proposes' ;;
    G1) printf 'A governed Mandate change does not execute below its confirmation threshold (stays awaiting-nodes, Mandate unchanged)' ;;
    G2) printf 'Once the confirmation threshold is met the governed Mandate change executes (new Mandate version and cap)' ;;
    R1) printf 'The original Mandate cap is restored with a second governed change' ;;
  esac
}

# result <id> <PASS|FAIL> <detail> <anchor>
result() {
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >>"$RESULTS"
  if [ "$2" = "PASS" ]; then log_ok "$1 $(claim_text "$1")"; else printf '\xe2\x9c\x97 %s FAILED: %s. %s\n' "$1" "$(claim_text "$1")" "$3"; fi
}

# ---------------------------------------------------------------------------------------------------
# Backend API (cookie session). Prints the response body; returns 0 for 2xx, 22 for other statuses
# (body still printed), 7 when nothing answered. Records the request and trimmed response in the report
# when record=1. In a dry run nothing is sent: the request is printed and dry_api answers.
# ---------------------------------------------------------------------------------------------------
api_do() {
  local record="$1" method="$2" path="$3" body="${4:-}" shown_body out status rc=0 cmd
  shown_body="$body"
  case "$path" in /api/session/localnet/sign-in) shown_body='{"password":"***"}' ;; esac
  cmd="curl -sS -X $method '$BASE_URL$path'"
  if [ -n "$body" ]; then cmd="$cmd -H 'Content-Type: application/json' -d '$shown_body'"; fi
  if is_dry; then
    printf '  HTTP %s %s%s\n' "$method" "$BASE_URL" "$path" >&3
    if [ -n "$body" ]; then printf '       body: %s\n' "$shown_body" >&3; fi
    dry_api "$method" "$path" "$body"
    return 0
  fi
  out="$(mktemp "$WORK/resp.XXXXXX")"
  local args=(-sS --max-time "$HTTP_TIMEOUT" -o "$out" -w '%{http_code}' -X "$method" -H 'Accept: application/json' -b "$JAR" -c "$JAR")
  if [ -n "$body" ]; then args+=(-H 'Content-Type: application/json' --data-binary "$body"); fi
  if ! status="$(curl "${args[@]}" "$BASE_URL$path" 2>"$WORK/curl.err")"; then
    status="000"
    printf 'curl failed: %s\n' "$(cat "$WORK/curl.err")" >"$out"
    rc=7
  fi
  case "$status" in 2??) ;; *) [ "$rc" -ne 0 ] || rc=22 ;; esac
  if [ "$record" = "1" ]; then
    {
      printf '```\n$ %s\nHTTP %s\n%s\n```\n\n' "$cmd" "$status" "$(jshort 1500 <"$out")"
    } >>"$BODY"
  fi
  cat "$out"
  rm -f "$out"
  return $rc
}
api() { api_do 1 "$@"; }
api_quiet() { api_do 0 "$@"; }

# run_node <label> <command...>: runs scripts/localnet-node.sh, records the command and its output.
run_node() {
  local label="$1" out rc=0
  shift
  if is_dry; then
    printf '  [dry-run] would run: %s\n' "$*" >&3
    dry_node "$@"
    return 0
  fi
  out="$(timeout_cmd "$NODE_CMD_TIMEOUT" "$@" 2>&1)" || rc=$?
  {
    printf '```\n$ %s\n%s\n(exit %s)\n```\n\n' "$label" "$(printf '%s' "$out" | short 1800)" "$rc"
  } >>"$BODY"
  return $rc
}

# timeout_cmd <seconds> <command...>: GNU timeout when present (not on a stock macOS), else run as is.
timeout_cmd() {
  local secs="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"; else "$@"; fi
}

node_set() { # <b|c> <offline|online>
  local node="$1" action="$2"
  if [ "$action" = "offline" ]; then
    # Set the flag first: a node that fails half way must still be brought back by the exit trap.
    if [ "$node" = "b" ]; then B_OFF=1; else C_OFF=1; fi
    if [ "$node" = "c" ]; then
      MITHRA_ALLOW_C_OFFLINE=bitsafe-demo run_node "scripts/localnet-node.sh c offline --allow-c" "$SCRIPT_DIR/localnet-node.sh" c offline --allow-c
    else
      run_node "scripts/localnet-node.sh b offline" "$SCRIPT_DIR/localnet-node.sh" b offline
    fi
  else
    run_node "scripts/localnet-node.sh $node online" "$SCRIPT_DIR/localnet-node.sh" "$node" online
    if [ "$node" = "b" ]; then B_OFF=0; else C_OFF=0; fi
  fi
}

# ---------------------------------------------------------------------------------------------------
# Polling (never fatal: a timeout is recorded as a failed claim, and the script goes on to bring nodes back)
# poll <timeout> <command...>: the command prints its state and returns 0 when done, 2 when it can never
# become ready, anything else for "not yet". POLL_OUT holds the last output. Returns 0, 1 (timeout) or 2.
# ---------------------------------------------------------------------------------------------------
POLL_OUT=""
poll() {
  local timeout="$1" start=$SECONDS rc
  shift
  POLL_OUT=""
  if is_dry; then
    POLL_OUT="$("$@")" || true
    return 0
  fi
  while :; do
    rc=0
    POLL_OUT="$("$@" 2>&1)" || rc=$?
    [ "$rc" -eq 0 ] && return 0
    [ "$rc" -eq 2 ] && return 2
    [ $((SECONDS - start)) -ge "$timeout" ] && return 1
    sleep "$POLL_INTERVAL"
  done
}

# ---------------------------------------------------------------------------------------------------
# Small readers
# ---------------------------------------------------------------------------------------------------
cycle_detail() { api_quiet GET "/api/cycles/$1"; }
cycle_status() { { cycle_detail "$1" 2>/dev/null || true; } | jq -r '.summary.status // "unknown"' 2>/dev/null || printf 'unknown'; }

# infra_is <regex>: succeeds when the Infrastructure summary matches. Prints the summary.
infra_is() {
  local out summary
  out="$(api_quiet GET /api/infrastructure)" || { printf 'infrastructure request failed: %s' "$out"; return 1; }
  summary="$(printf '%s' "$out" | jq -r '.summary // ""')"
  printf '%s' "$summary"
  printf '%s' "$summary" | grep -Eq "$1"
}

# wait_infra <regex> <label>: waits (the answer is cached 30 s), then records the full answer.
wait_infra() {
  local rc=0 out
  poll "$INFRA_WAIT" infra_is "$1" || rc=$?
  out="$(api GET /api/infrastructure 2>/dev/null)" || true
  INFRA_SUMMARY="$(printf '%s' "$out" | jq -r '.summary // ""' 2>/dev/null || true)"
  return $rc
}
INFRA_SUMMARY=""

month_before() { # YYYY-MM -> previous month, no date(1) arithmetic (portable)
  local y m
  y="${1%-*}"
  m="${1#*-}"
  m=$((10#$m - 1))
  if [ "$m" -eq 0 ]; then m=12; y=$((10#$y - 1)); fi
  printf '%04d-%02d' "$((10#$y))" "$m"
}

cycle_exists_active() { # cycle id: true when the list has it and it did not fail, get rejected or cancelled
  api_quiet GET /api/cycles 2>/dev/null | jq -e --arg c "$1" '[.cycles[]? | select(.cycleId == $c and (.status | IN("failed","rejected","cancelled") | not))] | length > 0' >/dev/null 2>&1
}

# ---------------------------------------------------------------------------------------------------
# Dry-run answers for the backend (stand-ins with the real shapes; ledger and DecMan answers come from
# scripts/lib/dryrun.sh). State lives in $DRY_DIR.
# ---------------------------------------------------------------------------------------------------
dry_node() { # the localnet-node.sh arguments
  local node="" action="" a
  for a in "$@"; do
    case "$a" in a | b | c) node="$a" ;; offline | online) action="$a" ;; esac
  done
  if [ "$action" = "offline" ]; then : >"$DRY_DIR/off_$node"; else rm -f "$DRY_DIR/off_$node"; fi
}

dry_api() { # method path body
  local method="$1" path="$2" body="${3:-}" off=0 cycle ver cap
  [ -f "$DRY_DIR/off_b" ] && off=$((off + 1))
  [ -f "$DRY_DIR/off_c" ] && off=$((off + 1))
  case "$method $path" in
    "POST /api/session/localnet/sign-in") printf '{"network":"localnet","testMode":true,"signedIn":true,"party":null}' ;;
    "GET /api/session/demo-parties") printf '{"parties":[{"partyId":"mithra-treasurer::1220dry","displayName":"Treasurer","roles":["treasurer"]},{"partyId":"mithra-holder-a::1220dry","displayName":"Holder A","roles":["holder"]}]}' ;;
    "POST /api/session/switch") printf '{"network":"localnet","testMode":true,"signedIn":true,"party":{"partyId":"mithra-treasurer::1220dry","displayName":"Treasurer","roles":["treasurer"],"primaryRole":"treasurer"}}' ;;
    "GET /api/infrastructure")
      jq -cn --argjson off "$off" --arg t "$(dry_party "$TREASURY_PARTY_HINT")" --argjson th "$HOSTING_THRESHOLD" \
        --arg offb "$([ -f "$DRY_DIR/off_b" ] && echo 1 || echo 0)" --arg offc "$([ -f "$DRY_DIR/off_c" ] && echo 1 || echo 0)" '
        ($off) as $o | (3 - $o) as $on |
        {treasuryParty: $t, hostingThreshold: $th,
         nodes: [{id:"a",name:"Node A",operator:"Mithra Labs (app provider)",online:true,hostsTreasury:true},
                 {id:"b",name:"Node B",operator:"Ledgerline Fund Services (fund administrator)",online:($offb=="0"),hostsTreasury:true},
                 {id:"c",name:"Node C",operator:"Canton super validator (synchronizer operator)",online:($offc=="0"),hostsTreasury:true}],
         summary: (if $on >= 3 then "Running on 3 of 3 nodes" elif $on >= $th then "Still running on \($on) of 3 nodes"
                   else "Below threshold: \($on) of 3 nodes online. Payments and approvals wait until a second node is back." end)}'
      ;;
    "GET /api/mandate")
      read -r ver cap <"$DRY_DIR/mandate"
      jq -cn --argjson v "$ver" --arg cap "$cap" '{version:$v, terms:{cap:$cap, approvers:[{partyId:"approver-1::1220dry",displayName:"Approver 1"},{partyId:"approver-2::1220dry",displayName:"Approver 2"},{partyId:"approver-3::1220dry",displayName:"Approver 3"}], approvalThreshold:2, assetSymbol:"CC", scheduleCron:"0 9 1 * *", scheduleTimezone:"UTC", recordDateRule:"last_day_of_previous_month", fixedAmount:null, deviationPct:"50.0000000000", trailingCycles:3, unitChangePct:"50.0000000000", unitChangeWindowDays:3, feeBuffer:"10.0000000000"}, agentExecutes:true}'
      ;;
    "GET /api/cycles") printf '{"cycles":[]}' ;;
    "POST /api/cycles/run")
      cycle="$(printf '%s' "$body" | jq -r '.cycleId')"
      printf 'run\n' >>"$DRY_DIR/runs_$cycle"
      printf '{"cycleId":"%s"}' "$cycle"
      ;;
    "GET /api/cycles/"*)
      cycle="${path#/api/cycles/}"
      cycle="${cycle%%/*}"
      dry_cycle "$cycle"
      ;;
    "POST /api/cycles/"*"/cancel")
      cycle="${path#/api/cycles/}"
      cycle="${cycle%%/*}"
      touch "$DRY_DIR/cancelled_$cycle"
      dry_cycle "$cycle"
      ;;
    "PUT /api/policy/draft")
      printf '%s' "$body" | jq -r '.fields.cap' >"$DRY_DIR/draft_cap"
      printf '{"draftId":"draft-dry-1","fields":%s,"source":"edited"}' "$(printf '%s' "$body" | jq -c '.fields')"
      ;;
    "POST /api/mandate/seal")
      : >"$DRY_DIR/seal_pending"
      printf '{"sealId":"seal-dry-1","state":"awaiting-nodes","treasurerSigned":true,"nodeConfirmations":{"required":2,"confirmed":1,"nodes":[]},"mandateVersion":null,"error":null}'
      ;;
    "GET /api/mandate/seal/"*)
      if [ -f "$DRY_DIR/off_b" ] || [ ! -f "$DRY_DIR/seal_pending" ]; then
        if [ ! -f "$DRY_DIR/seal_pending" ]; then
          read -r ver cap <"$DRY_DIR/mandate"
          printf '{"sealId":"seal-dry-1","state":"sealed","treasurerSigned":true,"nodeConfirmations":{"required":2,"confirmed":2,"nodes":[]},"mandateVersion":%s,"error":null}' "$ver"
        else
          printf '{"sealId":"seal-dry-1","state":"awaiting-nodes","treasurerSigned":true,"nodeConfirmations":{"required":2,"confirmed":1,"nodes":[{"id":"a","name":"Node A","operator":"Mithra Labs (app provider)","confirmed":true},{"id":"b","name":"Node B","operator":"Ledgerline Fund Services (fund administrator)","confirmed":false},{"id":"c","name":"Node C","operator":"Canton super validator (synchronizer operator)","confirmed":false}]},"mandateVersion":null,"error":null}'
        fi
      else
        read -r ver cap <"$DRY_DIR/mandate"
        printf '%s %s\n' "$((ver + 1))" "$(cat "$DRY_DIR/draft_cap")" >"$DRY_DIR/mandate"
        rm -f "$DRY_DIR/seal_pending"
        printf '{"sealId":"seal-dry-1","state":"sealed","treasurerSigned":true,"nodeConfirmations":{"required":2,"confirmed":2,"nodes":[]},"mandateVersion":%s,"error":null}' "$((ver + 1))"
      fi
      ;;
    "GET /api/session") printf '{"network":"localnet","testMode":true,"signedIn":true,"party":null}' ;;
    *) printf '{}' ;;
  esac
}

dry_cycle() { # cycle id
  local c="$1" runs=0 status error="null" proposal='{"payouts":[{"holder":{"displayName":"Holder A"},"amount":"40.0000000000","payment":{"status":"paid","link":{"updateId":"1220dryrunupdate01","href":"/app/tx/1220dryrunupdate01","external":false}}},{"holder":{"displayName":"Holder D"},"amount":"250.0000000000","payment":{"status":"awaiting-acceptance","link":{"updateId":"1220dryrunupdate02","href":"/app/tx/1220dryrunupdate02","external":false}}}]}'
  [ -f "$DRY_DIR/runs_$c" ] && runs="$(wc -l <"$DRY_DIR/runs_$c" | tr -d ' ')"
  if [ -f "$DRY_DIR/cancelled_$c" ]; then
    status="cancelled"
  elif [ -f "$DRY_DIR/off_b" ] && [ -f "$DRY_DIR/off_c" ]; then
    status="failed"
    error="\"$EXPECTED_MESSAGE\""
    proposal="null"
  elif [ -n "${CYCLE_B:-}" ] && [ "$c" = "$CYCLE_B" ]; then
    if [ "$runs" -lt 2 ]; then
      status="failed"
      error="\"$EXPECTED_MESSAGE\""
      proposal="null"
    else
      status="awaiting-approval"
      proposal='{"payouts":[]}'
    fi
  else
    status="awaiting-acceptance"
  fi
  printf '{"summary":{"cycleId":"%s","status":"%s"},"proposal":%s,"error":%s}' "$c" "$status" "$proposal" "$error"
}

# ---------------------------------------------------------------------------------------------------
# Exit handling: nodes always come back, a report is always written (also after an error)
# ---------------------------------------------------------------------------------------------------
restore_nodes() {
  if [ "$C_OFF" = "1" ]; then
    printf '[bitsafe] bringing node C back online ...\n'
    "$SCRIPT_DIR/localnet-node.sh" c online >/dev/null 2>&1 || printf 'WARNING: could not bring node C online. Run: scripts/localnet-node.sh c online\n' >&2
    C_OFF=0
  fi
  if [ "$B_OFF" = "1" ]; then
    printf '[bitsafe] bringing node B back online ...\n'
    "$SCRIPT_DIR/localnet-node.sh" b online >/dev/null 2>&1 || printf 'WARNING: could not bring node B online. Run: scripts/localnet-node.sh b online\n' >&2
    B_OFF=0
  fi
}

on_exit() {
  local rc=$?
  trap - EXIT
  set +e
  if ! is_dry; then restore_nodes; fi
  if [ "$FINALIZED" = "0" ] && [ "$MAIN_STARTED" = "1" ] && ! is_dry; then
    rep ""
    rep "**The run stopped early (exit code $rc). Claims not reached are listed as NOT RUN above.**"
    finalize 1 || true
  fi
  if is_dry; then dry_cleanup; fi
  rm -rf "$WORK"
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

# ---------------------------------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------------------------------
finalize() { # <aborted 0|1>
  local aborted="$1" id res detail anchor total=0 failed=0 expected="B1 B2 O1 O2 T1 T2 T3 T4 G1 G2" commit
  FINALIZED=1
  [ "$KEEP" = "1" ] || expected="$expected R1"
  commit="$(git -C "$MITHRA_ROOT" rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
  mkdir -p "$REPORT_DIR"
  {
    printf '# BitSafe evidence: LocalNet run %s\n\n' "$STAMP"
    printf 'Produced by `scripts/bitsafe-demo.sh` on a real LocalNet (Splice %s). Nothing in this file was written by hand.\n\n' "$SPLICE_VERSION"
    printf '| | |\n|---|---|\n'
    printf '| Started | %s |\n| Finished | %s |\n| Backend | %s |\n| Git commit | %s |\n' "$STARTED_AT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$BASE_URL" "$commit"
    printf '| Hosting threshold | %s of %s (from `localnet/nodes.env`) |\n| Governance threshold | %s of %s |\n' "$HOSTING_THRESHOLD" "$NODE_COUNT" "$GOVERNANCE_THRESHOLD" "$NODE_COUNT"
    printf '| Options | keep=%s, step 2 cycle=%s, step 3 cycle=%s, step 2 total=%s |\n\n' "$KEEP" "${CYCLE_A:-?}" "${CYCLE_B:-?}" "$TOTAL_A"
    printf '## Summary\n\n| # | Claim | Result | Evidence |\n|---|---|---|---|\n'
  } >"$WORK/head.md"
  for id in $expected; do
    total=$((total + 1))
    res="$(awk -F'\t' -v id="$id" '$1 == id { r = $2 } END { print r }' "$RESULTS")"
    detail="$(awk -F'\t' -v id="$id" '$1 == id { d = $3 } END { print d }' "$RESULTS")"
    anchor="$(awk -F'\t' -v id="$id" '$1 == id { a = $4 } END { print a }' "$RESULTS")"
    if [ -z "$res" ]; then
      res="NOT RUN"
      detail="the run did not reach this claim"
      case "$id" in B*) anchor="step-1" ;; O*) anchor="step-2" ;; T*) anchor="step-3" ;; *) anchor="step-4" ;; esac
    fi
    [ "$res" = "PASS" ] || failed=$((failed + 1))
    detail="${detail//|/\\|}"
    printf '| %s | %s | **%s** | [%s](#%s) |\n' "$id" "$(claim_text "$id")" "$res" "$detail" "$anchor" >>"$WORK/head.md"
  done
  {
    printf '\n'
    if [ "$failed" -eq 0 ] && [ "$aborted" = "0" ]; then
      printf '**Result: PASS (%s of %s claims).**\n\n' "$total" "$total"
    else
      printf '**Result: FAIL (%s of %s claims did not pass).** Failed claims keep their evidence below; do not edit this file, fix the cause and run the script again.\n\n' "$failed" "$total"
    fi
    printf '## Nodes and operators\n\n| Node | Operator | LocalNet participant | JSON Ledger API | DecMan | Auto-confirms Mithra actions |\n|---|---|---|---|---|---|\n'
    for id in $NODE_IDS; do
      printf '| %s | %s | `%s` | %s | %s | %s |\n' "$(node_label "$id")" "$(node_get "$id" OPERATOR)" "$(node_get "$id" PARTICIPANT)" "$(node_json_url "$id")" "$(node_decman_url "$id")" "$(node_get "$id" AUTO_CONFIRM)"
    done
    printf '\n'
  } >>"$WORK/head.md"
  cat "$WORK/head.md" "$BODY" >"$REPORT"
  printf '\nReport written: %s\n' "${REPORT#"$MITHRA_ROOT"/}"
  [ "$failed" -eq 0 ] && [ "$aborted" = "0" ]
}

# ---------------------------------------------------------------------------------------------------
# Sign in
# ---------------------------------------------------------------------------------------------------
demo_password() {
  local value="${LOCALNET_DEMO_PASSWORD:-}"
  if [ -z "$value" ] && [ -f "$MITHRA_ROOT/.env" ]; then
    value="$(sed -n 's/^LOCALNET_DEMO_PASSWORD=//p' "$MITHRA_ROOT/.env" | tail -n 1 | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//")"
  fi
  printf '%s' "$value"
}

sign_in_as_treasurer() {
  local password parties id out
  password="$(demo_password)"
  if [ -z "$password" ] && is_dry; then password="dry-run-password"; fi
  [ -n "$password" ] || die "LOCALNET_DEMO_PASSWORD is not set (environment or .env). It is the password of the LocalNet sign-in."
  out="$(api POST /api/session/localnet/sign-in "$(jq -cn --arg p "$password" '{password:$p}')")" ||
    die "sign-in failed. Is the backend running at $BASE_URL (MITHRA_URL) and is LOCALNET_DEMO_PASSWORD the one in its .env? Response: $(printf '%s' "$out" | short 300)"
  parties="$(api GET /api/session/demo-parties)" || die "could not read the demo parties"
  id="$(printf '%s' "$parties" | jq -r '[.parties[]? | select(.roles | index("treasurer"))][0].partyId // ([.parties[]? | select(.displayName == "Treasurer")][0].partyId // empty)')"
  [ -n "$id" ] || die "no demo party with the treasurer role. Run pnpm seed:localnet first (the organization must exist)."
  api POST /api/session/switch "$(jq -cn --arg p "$id" '{partyId:$p}')" >/dev/null || die "could not switch to the treasurer"
}

# ===================================================================================================
# Steps
# ===================================================================================================
ORIG_MANDATE=""
ORIG_VERSION=0
ORIG_CAP=""

step_setup() {
  say "Signing in as the treasurer at $BASE_URL"
  rep "<a id=\"setup\"></a>"
  rep "## Setup"
  rep ""
  rep "Signed in with the LocalNet password and switched to the treasurer, through the session API (cookie session)."
  rep ""
  sign_in_as_treasurer
  ORIG_MANDATE="$(api GET /api/mandate)" || die "there is no sealed Mandate: run pnpm seed:localnet (or finish the setup in the app) first. Response: $ORIG_MANDATE"
  ORIG_VERSION="$(printf '%s' "$ORIG_MANDATE" | jq -r '.version')"
  ORIG_CAP="$(printf '%s' "$ORIG_MANDATE" | jq -r '.terms.cap')"
  rep "Mandate at the start: version $ORIG_VERSION, cap $ORIG_CAP."
  rep ""
  if [ -z "$CYCLE_A" ]; then
    local today
    today="$(date -u +%Y-%m)"
    CYCLE_A="$(month_before "$today")"
  fi
  [ -n "$CYCLE_B" ] || CYCLE_B="$(month_before "$CYCLE_A")"
  [ "$CYCLE_A" != "$CYCLE_B" ] || die "the step 2 and step 3 cycles must differ"
  if [ "$(printf '%s %s' "$TOTAL_A" "$ORIG_CAP" | awk '{ print ($1 <= $2) ? "ok" : "over" }')" != "ok" ]; then
    die "--total $TOTAL_A is above the Mandate cap $ORIG_CAP; step 2 needs a cycle inside the cap."
  fi
  say "Step 2 cycle: $CYCLE_A (total $TOTAL_A), step 3 cycle: $CYCLE_B, Mandate cap $ORIG_CAP"
}

# ---------------------------------------------------------------------------------------------------
# Step 1: baseline
# ---------------------------------------------------------------------------------------------------
dm_party_entry() { # reads DecMan /decentralized-parties JSON on stdin; prints the party id found
  jq -r --arg p "$TREASURY_PARTY_HINT::" '[.. | strings | select(startswith($p))] | unique | .[0] // empty' 2>/dev/null
}

step1() {
  local anchor="step-1" status_out status_rc=0 infra infra_party n dm_json party="" found_on="" th_dm detail ok=1 found
  say "Step 1: baseline"
  rep "<a id=\"step-1\"></a>"
  rep "## Step 1: baseline, the treasury party and its hosting"
  rep ""
  rep "### 1a. LocalNet status"
  rep ""
  if is_dry; then
    printf '  [dry-run] would run: %s\n' "$SCRIPT_DIR/localnet-status.sh" >&3
  else
    status_out="$("$SCRIPT_DIR/localnet-status.sh" 2>&1)" || status_rc=$?
    printf '$ scripts/localnet-status.sh   (exit %s)\n%s\n' "$status_rc" "$status_out" | rep_block text
  fi

  rep "### 1b. The app's Infrastructure panel"
  rep ""
  infra="$(api GET /api/infrastructure)" || infra="{}"
  local n_nodes n_online n_hosts th summary
  n_nodes="$(printf '%s' "$infra" | jq -r '.nodes | length' 2>/dev/null || printf 0)"
  n_online="$(printf '%s' "$infra" | jq -r '[.nodes[] | select(.online)] | length' 2>/dev/null || printf 0)"
  n_hosts="$(printf '%s' "$infra" | jq -r '[.nodes[] | select(.hostsTreasury)] | length' 2>/dev/null || printf 0)"
  th="$(printf '%s' "$infra" | jq -r '.hostingThreshold // 0' 2>/dev/null || printf 0)"
  summary="$(printf '%s' "$infra" | jq -r '.summary // ""' 2>/dev/null || true)"
  infra_party="$(printf '%s' "$infra" | jq -r '.treasuryParty // ""' 2>/dev/null || true)"
  rep "Nodes: $n_nodes, online: $n_online, hosting the treasury: $n_hosts, hosting threshold: $th. Summary line: \"$summary\"."
  rep ""
  if [ "$n_nodes" = "$NODE_COUNT" ] && [ "$n_online" = "$NODE_COUNT" ] && printf '%s' "$summary" | grep -q "^Running on $NODE_COUNT of $NODE_COUNT nodes"; then
    result B2 PASS "$n_online of $n_nodes nodes online, \"$summary\"" "$anchor"
  else
    result B2 FAIL "expected 3 of 3 online and \"Running on 3 of 3 nodes\", got $n_online of $n_nodes online, \"$summary\"" "$anchor"
  fi

  rep "### 1c. The Decentralized Party in BitSafe's Decentralization Manager"
  rep ""
  rep "The party id, hosting nodes and threshold as DecMan reports them (\`GET /decentralized-parties\`), then as each node's own ledger API sees it."
  rep ""
  for n in $NODE_IDS; do
    dm_json="$(dm_curl "$n" GET /decentralized-parties 2>/dev/null)" || dm_json=""
    {
      printf '$ curl -s %s/decentralized-parties    # node %s DecMan\n%s\n' "$(node_decman_url "$n")" "$(node_label "$n")" "$(printf '%s' "${dm_json:-<no answer>}" | jshort 1500)"
    } | rep_block text
    found="$(printf '%s' "$dm_json" | dm_party_entry)"
    if [ -n "$found" ]; then found_on="${found_on:+$found_on, }$(node_label "$n")"; fi
    if [ "$n" = "a" ]; then party="$found"; DM_A_JSON="$dm_json"; fi
  done
  rep "Party id (DecMan A): \`${party:-not found}\`. Listed by DecMan on: ${found_on:-none}."
  rep ""
  # Threshold and hosting nodes from DecMan's entry, best effort: the exact response shape is only
  # verified on the owner's machine (docs/research/bitsafe-dm.md), so the raw response is above.
  th_dm="$(printf '%s' "${DM_A_JSON:-}" | jq -r --arg p "$TREASURY_PARTY_HINT::" '[.. | objects | select([.[]? | strings | select(startswith($p))] | length > 0) | .threshold? // empty] | .[0] // empty' 2>/dev/null || true)"
  if [ -n "$th_dm" ]; then rep "Threshold in DecMan's entry: **$th_dm**."; else rep "DecMan's response has no \`threshold\` field next to the party; read it from the raw response above or the DecMan UI (the hosting threshold in use is $HOSTING_THRESHOLD from \`localnet/nodes.env\`)."; fi
  rep ""
  local hosted="" T
  T="${infra_party:-$party}"
  if [ -n "$T" ]; then
    for n in $NODE_IDS; do
      local flag
      flag="$(ledger_curl "$n" GET "/v2/parties/$(urlenc "$T")" 2>/dev/null | jq -r '(.partyDetails | if type == "array" then .[0] else . end).isLocal // false' 2>/dev/null || true)"
      rep "- Node $(node_label "$n") ($(node_get "$n" OPERATOR)): \`GET $(node_json_url "$n")/v2/parties/{treasury}\` says isLocal = **${flag:-unknown}**."
      if [ "$flag" = "true" ]; then hosted="${hosted:+$hosted, }$(node_label "$n")"; fi
    done
    rep ""
  fi
  detail="party ${party:-none}; hosted on ${hosted:-none}; threshold $th"
  [ -n "$party" ] || ok=0
  [ -z "$infra_party" ] || [ "$infra_party" = "$party" ] || ok=0
  [ "$n_hosts" = "$NODE_COUNT" ] || ok=0
  [ "$th" = "$HOSTING_THRESHOLD" ] || ok=0
  [ -z "$th_dm" ] || [ "$th_dm" = "$HOSTING_THRESHOLD" ] || ok=0
  if is_dry || [ "$(printf '%s' "$hosted" | tr -cd ',' | wc -c | tr -d ' ')" = "$((NODE_COUNT - 1))" ]; then :; else ok=0; fi
  if [ "$ok" = "1" ]; then
    result B1 PASS "$detail${th_dm:+; DecMan threshold $th_dm}" "$anchor"
  else
    result B1 FAIL "$detail${th_dm:+; DecMan threshold $th_dm}. Expected the party on all $NODE_COUNT nodes (DecMan party, ledger isLocal, Infrastructure) with threshold $HOSTING_THRESHOLD" "$anchor"
  fi
}
DM_A_JSON=""

# ---------------------------------------------------------------------------------------------------
# Step 2: one node offline, a cycle still executes
# ---------------------------------------------------------------------------------------------------
payout_summary() { # cycle detail JSON on stdin
  jq -c '{status: .summary.status, error: .error, payouts: [.proposal.payouts[]? | {holder: .holder.displayName, amount: .amount, payment: .payment.status, updateId: .payment.link.updateId}]}' 2>/dev/null
}

cycle_paid() { # cycle id; prints a one-line state; 0 paid, 2 fatal, 1 not yet
  local detail st err
  detail="$(cycle_detail "$1")" || { printf 'cycle request failed: %s' "$detail"; return 1; }
  st="$(printf '%s' "$detail" | jq -r '.summary.status // "unknown"')"
  err="$(printf '%s' "$detail" | jq -r '.error // empty')"
  printf '%s%s' "$st" "${err:+ ($err)}"
  if printf '%s' "$st" | grep -Eq "$PAID_RE"; then return 0; fi
  if printf '%s' "$st" | grep -Eq '^(failed|rejected|cancelled|needs-funds|awaiting-approval)$'; then return 2; fi
  return 1
}

step2() {
  local anchor="step-2" rc=0 run out detail st ids
  say "Step 2: node B offline, cycle $CYCLE_A"
  rep "<a id=\"step-2\"></a>"
  rep "## Step 2: node B offline, a cycle still executes"
  rep ""
  rep "Node B (Ledgerline Fund Services) is disconnected from the synchronizer. Nodes A and C are two of three, so the hosting threshold of $HOSTING_THRESHOLD is met."
  rep ""
  if [ "$CYCLE_EXPLICIT" = "0" ] && cycle_exists_active "$CYCLE_A"; then
    result O2 FAIL "cycle $CYCLE_A already ran; pass --cycle YYYY-MM with a cycle that has not run" "$anchor"
    result O1 FAIL "skipped: step 2 did not start" "$anchor"
    return 0
  fi
  rc=0
  node_set b offline || rc=$?
  if [ "$rc" -ne 0 ]; then
    result O1 FAIL "could not take node B offline (see the command output above)" "$anchor"
    result O2 FAIL "node B was not taken offline" "$anchor"
    return 0
  fi
  rc=0
  wait_infra '^Still running on 2 of 3 nodes' || rc=$?
  if [ "$rc" -eq 0 ]; then
    result O1 PASS "\"$INFRA_SUMMARY\"" "$anchor"
  else
    result O1 FAIL "expected \"Still running on 2 of 3 nodes\", the panel says \"$INFRA_SUMMARY\" after ${INFRA_WAIT}s" "$anchor"
  fi

  rep "Run the cycle $CYCLE_A for $TOTAL_A (inside the cap $ORIG_CAP):"
  rep ""
  rc=0
  run="$(api POST /api/cycles/run "$(jq -cn --arg c "$CYCLE_A" --arg t "$TOTAL_A" '{cycleId:$c,total:$t}')")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    result O2 FAIL "starting the cycle failed: $(printf '%s' "$run" | short 300)" "$anchor"
  else
    rc=0
    poll "$CYCLE_WAIT" cycle_paid "$CYCLE_A" || rc=$?
    detail="$(api GET "/api/cycles/$CYCLE_A" 2>/dev/null)" || detail="{}"
    st="$(printf '%s' "$detail" | jq -r '.summary.status // "unknown"')"
    ids="$(printf '%s' "$detail" | jq -r '[.proposal.payouts[]? | .payment.link.updateId // empty] | unique | join(", ")')"
    {
      printf 'cycle %s: status %s\n%s\n' "$CYCLE_A" "$st" "$(printf '%s' "$detail" | payout_summary | short 1500)"
    } | rep_block text
    if [ "$rc" -eq 0 ]; then
      rep "Payout update ids (open in the app at \`/app/tx/<id>\`): ${ids:-none recorded}."
      rep ""
      result O2 PASS "cycle $CYCLE_A is $st with node B offline; payout update ids: ${ids:-none}" "$anchor"
    else
      out="$(printf '%s' "$POLL_OUT" | short 300)"
      result O2 FAIL "cycle $CYCLE_A did not reach paid-automatically or awaiting-acceptance (last: $out)" "$anchor"
    fi
  fi
  rc=0
  node_set b online || rc=$?
  if [ "$rc" -ne 0 ]; then rep "**Node B did not come back online: $(printf 'run scripts/localnet-node.sh b online')**"; rep ""; fi
  wait_infra '^Running on 3 of 3 nodes' || true
  rep "After node B is back the panel says: \"$INFRA_SUMMARY\"."
  rep ""
}

# ---------------------------------------------------------------------------------------------------
# Step 3: below the hosting threshold
# ---------------------------------------------------------------------------------------------------
cycle_settled() { # prints state; 0 when failed or proposed (terminal for this step), 1 while running
  local detail st err
  detail="$(cycle_detail "$1")" || { printf 'cycle request failed: %s' "$detail"; return 1; }
  st="$(printf '%s' "$detail" | jq -r '.summary.status // "unknown"')"
  err="$(printf '%s' "$detail" | jq -r '.error // empty')"
  printf '%s%s' "$st" "${err:+ ($err)}"
  if [ "$st" = "failed" ] || printf '%s' "$st" | grep -Eq "$PROPOSED_RE"; then return 0; fi
  return 1
}

cycle_not_running() { # 0 once the status is no longer running
  local st
  st="$(cycle_status "$1")"
  printf '%s' "$st"
  [ "$st" != "running" ]
}

step3() {
  local anchor="step-3" rc=0 total detail st err proposal log_off=0 log_lines run first_status id
  say "Step 3: nodes B and C offline, cycle $CYCLE_B"
  rep "<a id=\"step-3\"></a>"
  rep "## Step 3: below the hosting threshold"
  rep ""
  rep "Nodes B and C are both disconnected, so only node A (1 of 3) is online and the hosting threshold of $HOSTING_THRESHOLD cannot be met. **Node C hosts the DSO, so CC transfers stop everywhere while it is offline; the script brings C back at the end of this step (and on any error).** The action tried is a cycle proposal, which needs the treasury's confirmations but moves no CC."
  rep ""
  if [ "$BELOW_EXPLICIT" = "0" ] && cycle_exists_active "$CYCLE_B"; then
    for id in T1 T2 T3 T4; do result "$id" FAIL "cycle $CYCLE_B already ran; pass --below-cycle YYYY-MM with a cycle that has not run" "$anchor"; done
    return 0
  fi
  total="$(printf '%s' "$ORIG_CAP" | jq -R 'tonumber | floor + 100 | tostring')"
  total="${total//\"/}"
  rc=0
  node_set b offline || rc=$?
  if [ "$rc" -eq 0 ]; then node_set c offline || rc=$?; fi
  if [ "$rc" -ne 0 ]; then
    for id in T1 T2 T3 T4; do result "$id" FAIL "could not take nodes B and C offline (see the command output above)" "$anchor"; done
    node_set c online || true
    node_set b online || true
    return 0
  fi
  rc=0
  wait_infra '^Below threshold: 1 of 3 nodes online' || rc=$?
  if [ "$rc" -eq 0 ]; then
    result T1 PASS "\"$INFRA_SUMMARY\"" "$anchor"
  else
    result T1 FAIL "expected \"Below threshold: 1 of 3 nodes online...\", the panel says \"$INFRA_SUMMARY\" after ${INFRA_WAIT}s" "$anchor"
  fi

  if [ -n "$BACKEND_LOG" ] && [ -f "$BACKEND_LOG" ]; then log_off="$(wc -c <"$BACKEND_LOG" | tr -d ' ')"; fi
  rep "Run cycle $CYCLE_B for $total. The total is above the cap on purpose: if it ever gets through, it only becomes a proposal that waits for approvals, it cannot pay out."
  rep ""
  rc=0
  run="$(api POST /api/cycles/run "$(jq -cn --arg c "$CYCLE_B" --arg t "$total" '{cycleId:$c,total:$t}')")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    result T2 FAIL "starting the cycle failed: $(printf '%s' "$run" | short 300)" "$anchor"
    result T3 FAIL "the request itself failed; see the response above" "$anchor"
  else
    say "waiting up to ${BELOW_WAIT}s for the cycle to fail below the threshold (the ledger client retries and times out; this takes minutes)"
    poll "$BELOW_WAIT" cycle_settled "$CYCLE_B" || true
    detail="$(api GET "/api/cycles/$CYCLE_B" 2>/dev/null)" || detail="{}"
    st="$(printf '%s' "$detail" | jq -r '.summary.status // "unknown"')"
    err="$(printf '%s' "$detail" | jq -r '.error // empty')"
    proposal="$(printf '%s' "$detail" | jq -r 'if .proposal == null then "none" else "present" end')"
    first_status="$st"
    {
      printf 'cycle %s: status %s, proposal %s\nerror shown by the app: %s\n' "$CYCLE_B" "$st" "$proposal" "${err:-<none>}"
    } | rep_block text
    if { [ "$st" = "failed" ] || [ "$st" = "running" ]; } && [ "$proposal" = "none" ]; then
      result T2 PASS "cycle $CYCLE_B is $st with no proposal on the ledger side" "$anchor"
    else
      result T2 FAIL "cycle $CYCLE_B is $st, proposal $proposal: the treasury accepted work with two of its three nodes offline" "$anchor"
    fi
    if [ "$st" = "failed" ] && [ "$err" = "$EXPECTED_MESSAGE" ]; then
      result T3 PASS "cycle failed with: $err" "$anchor"
    elif [ "$st" = "failed" ]; then
      result T3 FAIL "cycle failed but the message is not the documented one. The app shows: \"$err\". Add the Canton error id to NODE_CONFIRMATION_ERROR_IDS in apps/backend/src/ledger/errors.ts (see the [mithra-ledger] line in the backend log)" "$anchor"
    else
      result T3 FAIL "the cycle is $st after ${BELOW_WAIT}s instead of failed with the documented message" "$anchor"
    fi
    if [ -n "$BACKEND_LOG" ] && [ -f "$BACKEND_LOG" ]; then
      log_lines="$(tail -c +"$((log_off + 1))" "$BACKEND_LOG" | grep -F '[mithra-ledger]' | head -n 20 || true)"
      rep "Raw ledger errors the backend logged while the nodes were offline (\`$BACKEND_LOG\`, lines starting \`[mithra-ledger]\`; correct \`NODE_CONFIRMATION_ERROR_IDS\` in \`apps/backend/src/ledger/errors.ts\` from them):"
      rep ""
      printf '%s\n' "${log_lines:-<no [mithra-ledger] line: either no mapped error occurred (see the cycle error above, which then carries the raw Canton text) or the backend logs elsewhere>}" | rep_block text
    else
      rep "The raw Canton error id is not in the API response. The backend writes one line starting \`[mithra-ledger] treasury nodes did not confirm:\` to its console for each mapped error; copy it from the backend terminal into this file by hand, or run this script with \`--backend-log FILE\` (start the backend with \`2>&1 | tee FILE\`) so it is recorded here automatically. If the cycle error above is not the documented message, that error text is the one to add to \`NODE_CONFIRMATION_ERROR_IDS\`."
      rep ""
    fi
  fi

  rep "### Recovery: bring node C and node B back, retry the same cycle"
  rep ""
  rc=0
  node_set c online || rc=$?
  node_set b online || rc=$?
  if [ "$rc" -ne 0 ]; then rep "**A node did not come back; run scripts/localnet-node.sh b online and c online.**"; rep ""; fi
  wait_infra '^Running on 3 of 3 nodes' || true
  rep "After the nodes are back the panel says: \"$INFRA_SUMMARY\"."
  rep ""
  # The first attempt may still be running its retries; let it finish before starting another.
  poll "$CYCLE_WAIT" cycle_not_running "$CYCLE_B" || true
  st="$(cycle_status "$CYCLE_B")"
  if [ "$st" = "failed" ]; then
    rep "The first attempt is failed; running the same cycle again (a failed cycle starts a new attempt):"
    rep ""
    rc=0
    api POST /api/cycles/run "$(jq -cn --arg c "$CYCLE_B" --arg t "$total" '{cycleId:$c,total:$t}')" >/dev/null || rc=$?
  fi
  rc=0
  poll "$CYCLE_WAIT" cycle_settled "$CYCLE_B" || rc=$?
  detail="$(api GET "/api/cycles/$CYCLE_B" 2>/dev/null)" || detail="{}"
  st="$(printf '%s' "$detail" | jq -r '.summary.status // "unknown"')"
  proposal="$(printf '%s' "$detail" | jq -r 'if .proposal == null then "none" else "present" end')"
  {
    printf 'cycle %s: status %s, proposal %s\n' "$CYCLE_B" "$st" "$proposal"
  } | rep_block text
  if printf '%s' "$st" | grep -Eq "$PROPOSED_RE" && [ "$proposal" = "present" ]; then
    result T4 PASS "cycle $CYCLE_B is $st with a proposal on the ledger (first attempt was ${first_status:-unknown})" "$anchor"
  else
    result T4 FAIL "cycle $CYCLE_B is $st (proposal $proposal) after the nodes came back; expected awaiting-approval" "$anchor"
  fi
  if [ "$KEEP" = "0" ]; then
    case "$st" in
      awaiting-approval | needs-funds | held | countdown)
        rep "Cancelling the proposal so it cannot pay out later (use --keep to leave it):"
        rep ""
        api POST "/api/cycles/$CYCLE_B/cancel" >/dev/null || rep "**Could not cancel the proposal; cancel cycle $CYCLE_B in the app.**"
        ;;
      *) rep "The cycle is $st; nothing to cancel." ; rep "" ;;
    esac
  else
    rep "--keep: the proposal for cycle $CYCLE_B is left in place (status $st)."
    rep ""
  fi
}

# ---------------------------------------------------------------------------------------------------
# Step 4: a governed action below its confirmation threshold
# ---------------------------------------------------------------------------------------------------
fields_with_cap() { # <cap>: the policy fields of the original Mandate with a new cap
  printf '%s' "$ORIG_MANDATE" | jq -c --arg cap "$1" '{fields: {
    cap: $cap,
    approvers: [.terms.approvers[].partyId],
    approvalThreshold: .terms.approvalThreshold,
    scheduleCron: .terms.scheduleCron,
    scheduleTimezone: .terms.scheduleTimezone,
    recordDateRule: .terms.recordDateRule,
    fixedAmount: .terms.fixedAmount,
    deviationPct: .terms.deviationPct,
    trailingCycles: .terms.trailingCycles,
    unitChangePct: .terms.unitChangePct,
    unitChangeWindowDays: .terms.unitChangeWindowDays,
    feeBuffer: .terms.feeBuffer}}'
}

seal_compact() { # SealStatus JSON on stdin
  jq -r '"state=\(.state) confirmations=\(.nodeConfirmations.confirmed // "-")/\(.nodeConfirmations.required // "-") version=\(.mandateVersion // "-")\(if .error then " error=\(.error)" else "" end)"' 2>/dev/null
}

seal_done() { # seal id; 0 sealed, 2 failed
  local out st
  out="$(api_quiet GET "/api/mandate/seal/$1")" || { printf 'seal request failed: %s' "$out"; return 1; }
  printf '%s' "$out" | seal_compact
  st="$(printf '%s' "$out" | jq -r '.state // "unknown"')"
  [ "$st" = "sealed" ] && return 0
  [ "$st" = "failed" ] && return 2
  return 1
}

# start_seal <cap>: prints the seal id (empty on failure); the requests are recorded
start_seal() {
  local draft draft_id seal
  draft="$(api PUT /api/policy/draft "$(fields_with_cap "$1")")" || { printf ''; return 0; }
  draft_id="$(printf '%s' "$draft" | jq -r '.draftId // empty')"
  [ -n "$draft_id" ] || { printf ''; return 0; }
  seal="$(api POST /api/mandate/seal "$(jq -cn --arg d "$draft_id" '{draftId:$d}')")" || { printf ''; return 0; }
  printf '%s' "$seal" | jq -r '.sealId // empty'
}

step4() {
  local anchor="step-4" newcap seal_id mandate rc=0 elapsed=0 line st conf req ver cap samples="" below_ok=1
  say "Step 4: governed Mandate change with node B offline"
  rep "<a id=\"step-4\"></a>"
  rep "## Step 4: a governed action below its confirmation threshold"
  rep ""
  rep "Sealing a Mandate change files a governed action (\`MandateChangeProposal\`) that needs $GOVERNANCE_THRESHOLD of $NODE_COUNT node confirmations through BitSafe's \`GovernanceRules\`. The backend auto-confirms on nodes A and B (\`AUTO_CONFIRM\` in \`localnet/nodes.env\`); node C is confirmed by hand in its own DecMan. With node B offline only node A can confirm."
  rep ""
  newcap="4000"
  if [ "$(printf '%s' "$ORIG_CAP" | jq -R 'tonumber')" = "4000" ]; then newcap="4500"; fi
  rc=0
  node_set b offline || rc=$?
  if [ "$rc" -ne 0 ]; then
    result G1 FAIL "could not take node B offline (see the command output above)" "$anchor"
    result G2 FAIL "skipped: node B was not taken offline" "$anchor"
    node_set b online || true
    return 0
  fi
  rep "Draft a Mandate change (cap $ORIG_CAP to $newcap, everything else as in the current Mandate) and seal it:"
  rep ""
  seal_id="$(start_seal "$newcap")"
  if [ -z "$seal_id" ]; then
    result G1 FAIL "could not draft and start the seal (see the responses above)" "$anchor"
    result G2 FAIL "skipped: the seal did not start" "$anchor"
    node_set b online || true
    return 0
  fi
  rep "Watching \`GET /api/mandate/seal/$seal_id\` for ${SEAL_OBSERVE}s with node B offline:"
  rep ""
  while :; do
    line="$(api_quiet GET "/api/mandate/seal/$seal_id" 2>/dev/null)" || line="{}"
    st="$(printf '%s' "$line" | jq -r '.state // "unknown"')"
    conf="$(printf '%s' "$line" | jq -r '.nodeConfirmations.confirmed // -1')"
    req="$(printf '%s' "$line" | jq -r '.nodeConfirmations.required // -1')"
    samples="${samples}+${elapsed}s $(printf '%s' "$line" | seal_compact)
"
    if [ "$st" != "awaiting-nodes" ] || [ "$conf" -ge "$req" ] 2>/dev/null; then below_ok=0; break; fi
    if is_dry || [ "$elapsed" -ge "$SEAL_OBSERVE" ]; then break; fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  printf '%s' "$samples" | rep_block text
  rep "Mandate while the seal waits (\`GET /api/mandate\`):"
  rep ""
  mandate="$(api GET /api/mandate)" || mandate="{}"
  ver="$(printf '%s' "$mandate" | jq -r '.version // 0')"
  cap="$(printf '%s' "$mandate" | jq -r '.terms.cap // ""')"
  if [ "$below_ok" = "1" ] && [ "$ver" = "$ORIG_VERSION" ] && [ "$cap" = "$ORIG_CAP" ]; then
    result G1 PASS "after ${SEAL_OBSERVE}s the seal is still awaiting-nodes with $conf of $req confirmations; Mandate unchanged (version $ver, cap $cap)" "$anchor"
  else
    result G1 FAIL "seal state $st with $conf of $req confirmations; Mandate version $ver (was $ORIG_VERSION), cap $cap (was $ORIG_CAP). Expected awaiting-nodes below the threshold and an unchanged Mandate" "$anchor"
  fi

  rep "### Threshold met: bring node B back"
  rep ""
  rc=0
  node_set b online || rc=$?
  if [ "$rc" -ne 0 ]; then rep "**Node B did not come back; run scripts/localnet-node.sh b online.**"; rep ""; fi
  rc=0
  poll "$SEAL_WAIT" seal_done "$seal_id" || rc=$?
  {
    printf '%s\n' "$POLL_OUT"
  } | rep_block text
  rep "Mandate afterwards:"
  rep ""
  mandate="$(api GET /api/mandate)" || mandate="{}"
  ver="$(printf '%s' "$mandate" | jq -r '.version // 0')"
  cap="$(printf '%s' "$mandate" | jq -r '.terms.cap // ""')"
  if [ "$rc" -eq 0 ] && [ "$ver" -gt "$ORIG_VERSION" ] && [ "$(printf '%s' "$cap" | jq -R 'tonumber')" = "$(printf '%s' "$newcap" | jq -R 'tonumber')" ]; then
    result G2 PASS "sealed: Mandate version $ORIG_VERSION to $ver, cap $ORIG_CAP to $cap" "$anchor"
  else
    result G2 FAIL "seal did not complete after node B returned (last: $(printf '%s' "$POLL_OUT" | short 200)); Mandate version $ver, cap $cap" "$anchor"
  fi

  if [ "$KEEP" = "1" ]; then
    rep "--keep: the Mandate stays at cap $cap (version $ver)."
    rep ""
    return 0
  fi
  rep "### Restore the original cap"
  rep ""
  seal_id="$(start_seal "$ORIG_CAP")"
  rc=0
  if [ -n "$seal_id" ]; then poll "$SEAL_WAIT" seal_done "$seal_id" || rc=$?; else rc=1; fi
  mandate="$(api GET /api/mandate)" || mandate="{}"
  ver="$(printf '%s' "$mandate" | jq -r '.version // 0')"
  cap="$(printf '%s' "$mandate" | jq -r '.terms.cap // ""')"
  if [ "$rc" -eq 0 ] && [ "$(printf '%s' "$cap" | jq -R 'tonumber')" = "$(printf '%s' "$ORIG_CAP" | jq -R 'tonumber')" ]; then
    result R1 PASS "cap back to $cap (Mandate version $ver)" "$anchor"
  else
    result R1 FAIL "the original cap $ORIG_CAP was not restored (Mandate version $ver, cap $cap, last: $(printf '%s' "$POLL_OUT" | short 200)); reseal it in the app" "$anchor"
  fi
}

# ===================================================================================================
# Main
# ===================================================================================================
if is_dry; then
  say "DRY RUN: every request is printed, nothing is sent, no node is touched, no report is written."
else
  say "BitSafe evidence run against $BASE_URL, report: ${REPORT#"$MITHRA_ROOT"/}"
  say "This pays test CC for cycle ${CYCLE_A:-<previous month>}, and takes nodes B and C offline (C stops all CC transfers until it is back)."
fi

step_setup
MAIN_STARTED=1
step1
step2
step3
step4

if is_dry; then
  say "Dry run finished: no report written. A real run writes docs/bitsafe-evidence/$STAMP.md"
  exit 0
fi
if finalize 0; then
  say "All claims passed. Commit the report: git add docs/bitsafe-evidence/$STAMP.md"
  exit 0
fi
say "Some claims did not pass; see the report."
exit 1
