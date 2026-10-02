#!/usr/bin/env bash
# Canned HTTP responses for `scripts/localnet-up.sh --dry-run`. Sourced by common.sh.
#
# In a dry run nothing is sent: http_call prints the request and asks dry_response for a plausible reply
# so that the whole flow can run with placeholder ids. Things that change as the flow progresses (the
# party exists after /onboarding, the rules exist after /contracts, ...) are tracked with marker files
# in $DRY_DIR, because http_call usually runs inside $( ) where shell variables would be lost.
# The shapes follow the verified notes in docs/research/bitsafe-dm.md; they are stand-ins, not a spec.

# shellcheck shell=bash disable=SC2034,SC2119,SC2120,SC2153

DRY_PARTY_SUFFIX="1220d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0"
DRY_RULES_CID="00a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"
DRY_PROPOSAL_CID="00b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2"

# dry_init: a fresh temp dir for state and markers. Testing hook: with DRY_DIR set to an existing directory
# the dry run reuses (and keeps) it, so a second `DRY_DIR=... localnet-up.sh --dry-run` shows the
# "already done" paths against the state the first run left behind.
dry_init() {
  if [ -n "${DRY_DIR:-}" ] && [ -d "$DRY_DIR" ]; then
    DRY_KEEP=1
  else
    DRY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mithra-dry.XXXXXX")"
    DRY_KEEP=0
  fi
  export DRY_DIR
  open_trace_fd
  STATE_FILE="$DRY_DIR/state.json"
}

dry_cleanup() {
  if [ "${DRY_KEEP:-0}" = "0" ] && [ -n "${DRY_DIR:-}" ] && [ -d "$DRY_DIR" ]; then rm -rf "$DRY_DIR"; fi
}

# dry_node_of_base <base-url>: node id (a|b|c) whose JSON or DecMan port the URL uses.
dry_node_of_base() {
  local n
  for n in $NODE_IDS; do
    case "$1" in
      *":$(node_get "$n" JSON_PORT)" | *":$(node_get "$n" DECMAN_PORT)")
        printf '%s' "$n"
        return 0
        ;;
    esac
  done
  printf 'a'
}

dry_party() { printf '%s::%s' "$1" "$DRY_PARTY_SUFFIX"; }

# dry_response <method> <base-url> <path-with-query> <body>
dry_response() {
  local method="$1" base="$2" path="${3%%\?*}" body="${4:-}" n hint
  n="$(dry_node_of_base "$base")"
  case "$method $path" in
    # ---- DecMan -------------------------------------------------------------------------------
    "GET /node-config") printf '{"node":{"participant_id":"PAR::participant-%s::1220%s"}}' "$n" "$n$n$n$n$n$n$n$n" ;;
    "GET /keys/status") printf '{"public_key":"02dryrunpublickey%s"}' "$n" ;;
    "POST /network-config") printf '{}' ;;
    "GET /decentralized-parties")
      if [ -f "$DRY_DIR/onboarded" ]; then
        printf '{"parties":[{"party_id":"%s","prefix":"%s"}]}' "$(dry_party "$TREASURY_PARTY_HINT")" "$TREASURY_PARTY_HINT"
      else
        printf '{"parties":[]}'
      fi
      ;;
    "POST /onboarding")
      : >"$DRY_DIR/onboarded"
      printf '{"status":"started"}'
      ;;
    "GET /onboarding/status" | "GET /dars/distribute/status" | "GET /contracts/status") printf '{"status":"completed"}' ;;
    "GET /invitations")
      printf '{"invitations":[{"id":"inv-onboarding-%s","invitation_type":"Onboarding","status":"pending"},{"id":"inv-dars-%s","invitation_type":"Dars","status":"pending"},{"id":"inv-contracts-%s","invitation_type":"Contracts","status":"pending"}]}' "$n" "$n" "$n"
      ;;
    "POST /invitations/accept") printf '{}' ;;
    "PUT /party-config") printf '{}' ;;
    "POST /dars/distribute")
      : >"$DRY_DIR/dars"
      printf '{"status":"started"}'
      ;;
    "GET /packages/vetted")
      if [ -f "$DRY_DIR/dars" ]; then printf '{"packages":["mithra-v1","governance-core-v1","governance-action-v1"]}'; else printf '{"packages":[]}'; fi
      ;;
    "POST /contracts")
      : >"$DRY_DIR/contracts"
      printf '{"status":"started"}'
      ;;
    "GET /governance/state")
      if [ -f "$DRY_DIR/contracts" ]; then printf '{"rules_contract_id":"%s"}' "$DRY_RULES_CID"; else printf '{}'; fi
      ;;
    "GET /participants-status") printf '{"participants":[]}' ;;
    "POST /governance/confirm")
      printf '%s\n' "$body" >>"$DRY_DIR/confirms.jsonl"
      printf '{"status":"confirmed"}'
      ;;
    "GET /governance/confirmations")
      if [ -f "$DRY_DIR/confirms.jsonl" ]; then
        jq -cs '
          def cids: to_entries | map("00c0ffee\(.key)00c0ffee\(.key)00c0ffee\(.key)00c0ffee\(.key)00c0ffee\(.key)");
          { core_self_actions: ([.[] | select(.governance_type == "core_self")] | group_by(.action.additional_proposer)
              | map({action: .[0].action, confirmations: cids})),
            domain_actions: ([.[] | select(.governance_type == "core_domain")] | group_by(.proposal_cid)
              | map({proposal_cid: .[0].proposal_cid, confirmations: cids, can_execute: (length >= 2)})) }' "$DRY_DIR/confirms.jsonl"
      else
        printf '{"core_self_actions":[],"domain_actions":[]}'
      fi
      ;;
    "POST /governance/execute")
      case "$body" in *core_domain*) : >"$DRY_DIR/charter" ;; esac
      printf '{"status":"executed"}'
      ;;
    # ---- JSON Ledger API ----------------------------------------------------------------------
    "GET /v2/version") printf '{"version":"3.5.8-dryrun"}' ;;
    "GET /v2/state/connected-synchronizers") printf '{"connectedSynchronizers":[{"synchronizerAlias":"global","synchronizerId":"global::1220dryrun"}]}' ;;
    "GET /v2/state/ledger-end") printf '{"offset":100}' ;;
    "GET /v2/parties")
      if [ -f "$DRY_DIR/parties_$n" ]; then
        jq -Rcs --arg s "$DRY_PARTY_SUFFIX" '{partyDetails: (split("\n") | map(select(length > 0)) | map({party: (. + "::" + $s), isLocal: true}))}' "$DRY_DIR/parties_$n"
      else
        printf '{"partyDetails":[]}'
      fi
      ;;
    "POST /v2/parties")
      hint="$(printf '%s' "$body" | jq -r '.partyIdHint')"
      printf '%s\n' "$hint" >>"$DRY_DIR/parties_$n"
      printf '{"partyDetails":{"party":"%s","isLocal":true}}' "$(dry_party "$hint")"
      ;;
    "POST /v2/users/"*"/rights") printf '{"newlyGrantedRights":[]}' ;;
    "POST /v2/state/active-contracts")
      case "$body" in
        *TreasuryCharter*)
          if [ -f "$DRY_DIR/charter" ]; then printf '[{"contractEntry":{"JsActiveContract":{"createdEvent":{"contractId":"00d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4"}}}}]'; else printf '[]'; fi
          ;;
        *CharterProposal*)
          if [ -f "$DRY_DIR/proposal" ]; then printf '[{"contractEntry":{"JsActiveContract":{"createdEvent":{"contractId":"%s"}}}}]' "$DRY_PROPOSAL_CID"; else printf '[]'; fi
          ;;
        *) printf '[]' ;;
      esac
      ;;
    "POST /v2/commands/submit-and-wait-for-transaction")
      : >"$DRY_DIR/proposal"
      printf '{"transaction":{"updateId":"dryrun","events":[{"CreatedEvent":{"contractId":"%s","templateId":"dryrunpkg:Mithra.Governance:CharterProposal"}}]}}' "$DRY_PROPOSAL_CID"
      ;;
    "GET /v2/parties/"*)
      printf '{"partyDetails":[{"party":"dryrun","isLocal":true}]}'
      ;;
    # ---- Validator scan proxy -----------------------------------------------------------------
    "GET /api/validator/v0/scan-proxy/dso-party-id") printf '{"dso_party_id":"DSO::%s"}' "$DRY_PARTY_SUFFIX" ;;
    *)
      printf '{}'
      printf '  (dry-run: no canned response for %s %s)\n' "$method" "$path" >&3
      ;;
  esac
}
