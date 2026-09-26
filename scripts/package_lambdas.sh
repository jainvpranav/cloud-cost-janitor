#!/usr/bin/env bash
# Build one zip per Lambda into dist/. Used by CI and for local checks.
# boto3 is provided by the Lambda runtime, so it is not bundled.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$ROOT/backend"
OUT="$ROOT/dist"
BUILD="$OUT/build"
PY_VERSION="${LAMBDA_PYTHON_VERSION:-3.11}"
PIP="${PIP:-pip}"

rm -rf "$OUT"
mkdir -p "$BUILD"

install_deps() {
  local requirements="$1" target="$2"
  local filtered
  filtered="$(mktemp)"
  grep -viE '^\s*(boto3|botocore)\b' "$requirements" | grep -vE '^\s*(#|$)' > "$filtered" || true
  if [[ -s "$filtered" ]]; then
    "$PIP" install --quiet --no-cache-dir --disable-pip-version-check \
      --platform manylinux2014_x86_64 --implementation cp --python-version "$PY_VERSION" \
      --only-binary=:all: --target "$target" -r "$filtered"
  fi
  rm -f "$filtered"
}

package() {
  local name="$1"; shift
  local dir="$BUILD/$name"
  mkdir -p "$dir"
  cp -R "$BACKEND/common" "$dir/common"
  for src in "$@"; do
    cp "$BACKEND/$src" "$dir/"
  done
  find "$dir" -name '__pycache__' -type d -prune -exec rm -rf {} +
  (cd "$dir" && zip -qr "$OUT/$name.zip" .)
  echo "built dist/$name.zip ($(du -h "$OUT/$name.zip" | cut -f1))"
}

package scanner scanner/lambda_function.py scanner/aws_client.py scanner/rules.py

install_deps "$BACKEND/enrichment/requirements.txt" "$BUILD/enrichment"
package enrichment enrichment/lambda_function.py enrichment/prompts.py

package teardown teardown/lambda_function.py scanner/aws_client.py scanner/rules.py

package api approval/api.py

install_deps "$BACKEND/mcp_server/requirements.txt" "$BUILD/mcp"
package mcp mcp_server/lambda_function.py mcp_server/server.py mcp_server/janitor_tools.py
