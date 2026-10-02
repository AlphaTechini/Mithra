#!/usr/bin/env bash
# Build and test the Mithra Daml packages.
#   scripts/daml.sh build   build mithra-v1 and mithra-tests
#   scripts/daml.sh test    build, then run the Daml Script tests
# Uses dpm when it is on PATH, otherwise the digitalasset/daml-sdk Docker image.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAML_DIR="$ROOT/daml"
IMAGE="${DAML_DOCKER_IMAGE:-digitalasset/daml-sdk:3.4.0-rc2}"
SDK_OVERRIDE="${DAML_DOCKER_SDK_VERSION:-3.4.0-rc2}"

cmd="${1:-}"
case "$cmd" in
  build | test) ;;
  *)
    echo "usage: scripts/daml.sh build|test" >&2
    exit 2
    ;;
esac

if command -v dpm >/dev/null 2>&1; then
  echo "[daml.sh] toolchain: dpm ($(command -v dpm))"
  cd "$DAML_DIR"
  dpm build --all
  if [ "$cmd" = "test" ]; then
    (cd mithra-tests && dpm test)
  fi
else
  if ! command -v docker >/dev/null 2>&1; then
    echo "[daml.sh] neither dpm nor docker found on PATH" >&2
    exit 1
  fi
  echo "[daml.sh] toolchain: docker image $IMAGE (daml assistant, SDK $SDK_OVERRIDE)"
  inner='set -e
cd /w/mithra && daml build --enable-multi-package=no
cd /w/mithra-tests && daml build --enable-multi-package=no'
  if [ "$cmd" = "test" ]; then
    inner="$inner
daml test"
  fi
  # Run the steps with errexit, then hand the generated .daml directories back to the
  # host user whatever the outcome, and exit with the steps' status.
  docker run --rm \
    -e DAML_SDK_VERSION="$SDK_OVERRIDE" \
    -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
    -v "$DAML_DIR":/w -w /w --user root \
    "$IMAGE" sh -c '
      sh -e -c "$1"
      status=$?
      chown -R "$HOST_UID:$HOST_GID" /w/mithra/.daml /w/mithra-tests/.daml 2>/dev/null || true
      exit $status' _ "$inner"
fi
