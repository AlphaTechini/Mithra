#!/usr/bin/env bash
# Merge localnet/.state/localnet.env (written by scripts/localnet-up.sh) into .env.
# Keys from localnet.env replace the same keys in .env; every other line, including secrets such as
# LLM_API_KEY, stays as it is. A missing .env is created from .env.example. The old .env is saved as .env.bak.
# ENV_FILE=<path> merges into another file.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

SRC="${LOCALNET_ENV_FILE:-$STATE_DIR/localnet.env}"
DEST="${ENV_FILE:-$MITHRA_ROOT/.env}"

[ -f "$SRC" ] || die "$SRC not found. Run scripts/localnet-up.sh first."

if [ -f "$DEST" ]; then
  cp "$DEST" "$DEST.bak"
elif [ -f "$MITHRA_ROOT/.env.example" ]; then
  cp "$MITHRA_ROOT/.env.example" "$DEST"
else
  : >"$DEST"
fi

TMP="$(mktemp "${TMPDIR:-/tmp}/mithra-env.XXXXXX")"
awk '
  NR == FNR {
    if ($0 ~ /^[A-Za-z_][A-Za-z0-9_]*=/) { k = substr($0, 1, index($0, "=") - 1); v[k] = $0; order[++n] = k }
    next
  }
  {
    if (match($0, /^[A-Za-z_][A-Za-z0-9_]*=/)) {
      k = substr($0, 1, RLENGTH - 1)
      if (k in v) { print v[k]; seen[k] = 1; next }
    }
    print
  }
  END {
    first = 1
    for (i = 1; i <= n; i++) {
      k = order[i]
      if (!(k in seen)) {
        if (first) { print ""; print "# Added by scripts/localnet-env.sh"; first = 0 }
        print v[k]
      }
    }
  }' "$SRC" "$DEST" >"$TMP"
mv "$TMP" "$DEST"

log_ok "Merged $(grep -c '^[A-Za-z_][A-Za-z0-9_]*=' "$SRC") settings from localnet/.state/localnet.env into $DEST"
if ! grep -q '^LOCALNET_DEMO_PASSWORD=.\+' "$DEST"; then
  log_warn "LOCALNET_DEMO_PASSWORD is not set in $DEST. The backend needs it for the demo sign-in; choose one and add it."
fi
