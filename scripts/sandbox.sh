#!/usr/bin/env bash
# Start, stop and inspect the Canton sandbox that the backend integration tests run against.
#   scripts/sandbox.sh start    run the sandbox with the Mithra DARs, wait until it accepts party allocation
#   scripts/sandbox.sh stop     remove the sandbox container
#   scripts/sandbox.sh status   say whether it is running and ready
#
# The sandbox has no authentication (ledger user "participant_admin") and listens on the host:
# JSON Ledger API on http://localhost:7575. Uses the digitalasset/daml-sdk Docker image, the
# same one scripts/daml.sh builds with. Builds the DARs first when they are missing.
#
# Overrides (environment): SANDBOX_CONTAINER (mithra-sandbox), SANDBOX_PORT (7575),
# SANDBOX_IMAGE (digitalasset/daml-sdk:3.4.0-rc2), SANDBOX_PORT_BASE (move the other sandbox
# ports to BASE..BASE+4, to run a second sandbox next to the first), SANDBOX_TIMEOUT (seconds
# to wait for readiness, 240).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="${SANDBOX_CONTAINER:-mithra-sandbox}"
PORT="${SANDBOX_PORT:-7575}"
IMAGE="${SANDBOX_IMAGE:-digitalasset/daml-sdk:3.4.0-rc2}"
TIMEOUT="${SANDBOX_TIMEOUT:-240}"
URL="http://localhost:${PORT}"
MITHRA_DAR="$ROOT/daml/mithra/.daml/dist/mithra-v1-0.1.0.dar"
TESTS_DAR="$ROOT/daml/mithra-tests/.daml/dist/mithra-tests-0.1.0.dar"

log() { echo "[sandbox.sh] $*"; }
die() { echo "[sandbox.sh] $*" >&2; exit 1; }

need_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not on PATH. Install Docker, then run this again."
  command -v curl >/dev/null 2>&1 || die "curl is not on PATH."
}

is_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)" = "true" ]
}

version_ok() {
  curl -fsS -m 3 "$URL/v2/version" >/dev/null 2>&1
}

# Party allocation fails until the node has a connected synchronizer, so allocating a party is
# the real readiness check. The party is harmless; its hint is unique per call.
allocation_ok() {
  curl -fsS -m 10 -X POST "$URL/v2/parties" -H 'content-type: application/json' \
    -d "{\"partyIdHint\":\"sandbox-ready-$(date +%s)-$RANDOM\",\"identityProviderId\":\"\"}" >/dev/null 2>&1
}

wait_ready() {
  local deadline=$((SECONDS + TIMEOUT))
  log "waiting for the JSON Ledger API at $URL"
  until version_ok; do
    is_running || { docker logs --tail 40 "$CONTAINER" >&2 || true; die "the sandbox container stopped; see the log above"; }
    [ "$SECONDS" -lt "$deadline" ] || die "the JSON Ledger API did not answer within ${TIMEOUT}s (docker logs $CONTAINER)"
    sleep 2
  done
  log "waiting until party allocation works (about 20 s after the API answers)"
  until allocation_ok; do
    [ "$SECONDS" -lt "$deadline" ] || die "party allocation still fails after ${TIMEOUT}s (docker logs $CONTAINER)"
    sleep 2
  done
  log "ready: $URL (ledger version $(curl -fsS "$URL/v2/version" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'))"
}

cmd_start() {
  need_docker
  if is_running; then
    log "$CONTAINER is already running"
    wait_ready
    return
  fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  if [ ! -f "$MITHRA_DAR" ] || [ ! -f "$TESTS_DAR" ]; then
    log "the Mithra DARs are missing; building them"
    "$ROOT/scripts/daml.sh" build
  fi
  local ports=""
  if [ -n "${SANDBOX_PORT_BASE:-}" ]; then
    local b="$SANDBOX_PORT_BASE"
    ports="--port $b --admin-api-port $((b + 1)) --sequencer-public-port $((b + 2)) --sequencer-admin-port $((b + 3)) --mediator-admin-port $((b + 4))"
  fi
  log "starting $CONTAINER from $IMAGE"
  # shellcheck disable=SC2016  # the single-quoted command runs inside the container
  docker run -d --name "$CONTAINER" --network host -v "$ROOT/daml":/w --user root --entrypoint sh "$IMAGE" -c \
    "daml sandbox $ports --json-api-port $PORT --wall-clock-time \
      --dar /w/mithra/.daml/dist/mithra-v1-0.1.0.dar \
      --dar /w/mithra-tests/.daml/dist/mithra-tests-0.1.0.dar" >/dev/null
  wait_ready
}

cmd_stop() {
  need_docker
  if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    docker rm -f "$CONTAINER" >/dev/null
    log "stopped and removed $CONTAINER"
  else
    log "$CONTAINER is not running"
  fi
}

cmd_status() {
  need_docker
  if ! is_running; then
    log "$CONTAINER is not running (start it with scripts/sandbox.sh start)"
    exit 1
  fi
  if version_ok; then
    log "$CONTAINER is running; $URL answers (ledger version $(curl -fsS "$URL/v2/version" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'))"
  else
    log "$CONTAINER is running but $URL does not answer yet"
    exit 1
  fi
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  *)
    echo "usage: scripts/sandbox.sh start|stop|status" >&2
    exit 2
    ;;
esac
