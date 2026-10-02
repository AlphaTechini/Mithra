#!/bin/bash
# Mirrors the Splice LocalNet console entrypoint (docker-compose/localnet/docker/console/entrypoint.sh,
# Splice 0.6.12): mint the three unsafe HS256 validator-user tokens, source the pre-startup scripts,
# then start the Canton console. The only difference is the last line: it runs
# /mithra/$MITHRA_CONSOLE_SCRIPT (a Canton console script) instead of the stock script.
#
# Required env (set by scripts/localnet-node.sh through compose.console.yaml):
#   MITHRA_CONSOLE_SCRIPT  file name inside localnet/console, e.g. node-offline.sc
#   MITHRA_PARTICIPANT     remote participant name: app-provider, app-user or sv
# The AUTH_* variables come from the bundle's env files (see compose.yaml `console` service).
set -eou pipefail

: "${MITHRA_CONSOLE_SCRIPT:?MITHRA_CONSOLE_SCRIPT is not set}"
: "${MITHRA_PARTICIPANT:?MITHRA_PARTICIPANT is not set}"

if [ ! -f "/mithra/$MITHRA_CONSOLE_SCRIPT" ]; then
  echo "console script /mithra/$MITHRA_CONSOLE_SCRIPT not found" >&2
  exit 2
fi

generate_jwt() {
  local sub="$1"
  local aud="$2"
  jwt-cli encode hs256 --s unsafe --p '{"sub": "'"$sub"'", "aud": "'"$aud"'"}'
}

APP_PROVIDER_VALIDATOR_USER_TOKEN=$(generate_jwt "$AUTH_APP_PROVIDER_VALIDATOR_USER_NAME" "$AUTH_APP_PROVIDER_AUDIENCE")
export APP_PROVIDER_VALIDATOR_USER_TOKEN
APP_USER_VALIDATOR_USER_TOKEN=$(generate_jwt "$AUTH_APP_USER_VALIDATOR_USER_NAME" "$AUTH_APP_USER_AUDIENCE")
export APP_USER_VALIDATOR_USER_TOKEN
SV_VALIDATOR_USER_TOKEN=$(generate_jwt "$AUTH_SV_VALIDATOR_USER_NAME" "$AUTH_SV_AUDIENCE")
export SV_VALIDATOR_USER_TOKEN

# Source all scripts from /app/pre-startup/on so that variables exported by them are visible here
# (same as the stock entrypoint).
for script in /app/pre-startup/on/*.sh; do
  # shellcheck disable=SC1090
  [ -f "$script" ] && source "$script"
done

# `run` executes the script, then exits (the stock entrypoint relies on the same behaviour).
exec /app/bin/canton run --no-tty -c /app/app.conf "/mithra/$MITHRA_CONSOLE_SCRIPT"
