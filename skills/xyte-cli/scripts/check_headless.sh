#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_CLI="$SCRIPT_DIR/run_xyte_cli.sh"
VALIDATE_SCHEMA="$SCRIPT_DIR/validate_with_schema.js"
TENANT_ID="${1:-}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

if [[ ! -x "$RUN_CLI" ]]; then
  echo "Missing launcher script: $RUN_CLI" >&2
  exit 1
fi

if [[ ! -x "$VALIDATE_SCHEMA" ]]; then
  echo "Missing validator script: $VALIDATE_SCHEMA" >&2
  exit 1
fi

REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
if [[ ! -f "$REPO_ROOT/dist/bin/xyte-cli.js" ]]; then
  echo "Build output missing at $REPO_ROOT/dist/bin/xyte-cli.js" >&2
  echo "Run: npm run build" >&2
  exit 1
fi

SCREENS=(setup config dashboard spaces devices incidents tickets)
META_KEYS=(inputState queueDepth droppedEvents transitionState refreshState navigationMode activePane availablePanes tabId tabOrder tabNavBoundary renderSafety tableFormat contract)
TMP_CFG="$(mktemp -d)"
trap 'rm -rf "$TMP_CFG"' EXIT

PASS_COUNT=0
for screen in "${SCREENS[@]}"; do
  cmd=("$RUN_CLI" tui --headless --screen "$screen" --format json --once --no-motion)
  if [[ -n "$TENANT_ID" ]]; then
    cmd+=(--tenant "$TENANT_ID")
  fi

  if [[ -n "$TENANT_ID" ]]; then
    output="$("${cmd[@]}")"
  else
    output="$(XYTE_CLI_CONFIG_DIR="$TMP_CFG" XYTE_CLI_KEYCHAIN_BACKEND=memory "${cmd[@]}")"
  fi

  runtime_frame="$(printf '%s\n' "$output" | jq -c 'select((.meta.startup // false) | not)' | tail -n1)"
  if [[ -z "$runtime_frame" ]]; then
    echo "FAIL [$screen] no runtime frame" >&2
    exit 1
  fi

  printf '%s\n' "$runtime_frame" | jq -e '.schemaVersion == "xyte.headless.frame.v1"' >/dev/null
  printf '%s\n' "$runtime_frame" | jq -e '.sessionId | type == "string"' >/dev/null
  printf '%s\n' "$runtime_frame" | jq -e '.sequence | type == "number"' >/dev/null

  for key in "${META_KEYS[@]}"; do
    printf '%s\n' "$runtime_frame" | jq -e --arg k "$key" '.meta | has($k)' >/dev/null
  done

  printf '%s\n' "$runtime_frame" | jq -e '.meta.contract.frameVersion == "xyte.headless.frame.v1"' >/dev/null

  runtime_path="$TMP_CFG/headless-$screen.json"
  printf '%s\n' "$runtime_frame" > "$runtime_path"
  "$VALIDATE_SCHEMA" "$REPO_ROOT/docs/schemas/headless-frame.v1.schema.json" "$runtime_path" >/dev/null

  runtime_screen="$(printf '%s\n' "$runtime_frame" | jq -r '.screen')"
  if [[ "$screen" != "setup" && "$screen" != "config" && "$runtime_screen" == "setup" ]]; then
    redirected_from="$(printf '%s\n' "$runtime_frame" | jq -r '.meta.redirectedFrom // ""')"
    if [[ "$redirected_from" != "$screen" ]]; then
      echo "FAIL [$screen] expected redirectedFrom=$screen, got '$redirected_from'" >&2
      exit 1
    fi
  fi

  printf '%s\n' "$runtime_frame" | jq -e '.panels | type == "array"' >/dev/null
  echo "PASS [$screen] runtime_screen=$runtime_screen"
  PASS_COUNT=$((PASS_COUNT + 1))
done

echo "Headless smoke passed: $PASS_COUNT/${#SCREENS[@]} screens"
