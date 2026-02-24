#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_CLI="$SCRIPT_DIR/run_xyte_cli.sh"
VALIDATE_SCHEMA="$SCRIPT_DIR/validate_with_schema.js"
TENANT_ID="${1:-}"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

if [[ -z "$TENANT_ID" ]]; then
  echo "Usage: $(basename "$0") <tenant-id>" >&2
  exit 1
fi

if [[ ! -x "$VALIDATE_SCHEMA" ]]; then
  echo "Missing validator script: $VALIDATE_SCHEMA" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Validating call envelope contract..."
set +e
CALL_OUTPUT="$("$RUN_CLI" call organization.devices.getDevices --tenant "$TENANT_ID" --output-mode envelope 2>/dev/null)"
CALL_EXIT=$?
set -e

if [[ -z "$CALL_OUTPUT" ]]; then
  echo "FAIL call envelope emitted empty output" >&2
  exit 1
fi
printf '%s\n' "$CALL_OUTPUT" | jq -e '.schemaVersion == "xyte.call.envelope.v1"' >/dev/null
printf '%s\n' "$CALL_OUTPUT" | jq -e '.requestId | type == "string"' >/dev/null
CALL_PATH="$TMP_DIR/call-envelope.json"
printf '%s\n' "$CALL_OUTPUT" > "$CALL_PATH"
"$VALIDATE_SCHEMA" "$REPO_ROOT/docs/schemas/call-envelope.v1.schema.json" "$CALL_PATH"
echo "PASS call envelope (exit=$CALL_EXIT)"

echo "Validating inspect fleet contract..."
FLEET_OUTPUT="$("$RUN_CLI" inspect fleet --tenant "$TENANT_ID" --format json)"
printf '%s\n' "$FLEET_OUTPUT" | jq -e '.schemaVersion == "xyte.inspect.fleet.v1"' >/dev/null
FLEET_PATH="$TMP_DIR/fleet.json"
printf '%s\n' "$FLEET_OUTPUT" > "$FLEET_PATH"
"$VALIDATE_SCHEMA" "$REPO_ROOT/docs/schemas/inspect-fleet.v1.schema.json" "$FLEET_PATH"
echo "PASS inspect fleet"

echo "Validating inspect deep-dive + report contracts..."
DEEP_OUTPUT="$("$RUN_CLI" inspect deep-dive --tenant "$TENANT_ID" --format json)"
printf '%s\n' "$DEEP_OUTPUT" | jq -e '.schemaVersion == "xyte.inspect.deep-dive.v1"' >/dev/null
DEEP_PATH="$TMP_DIR/deep-dive.json"
REPORT_PATH="$TMP_DIR/report.md"
printf '%s\n' "$DEEP_OUTPUT" > "$DEEP_PATH"
"$VALIDATE_SCHEMA" "$REPO_ROOT/docs/schemas/inspect-deep-dive.v1.schema.json" "$DEEP_PATH"

REPORT_OUTPUT="$("$RUN_CLI" report generate --tenant "$TENANT_ID" --input "$DEEP_PATH" --out "$REPORT_PATH" --format markdown)"
printf '%s\n' "$REPORT_OUTPUT" | jq -e '.schemaVersion == "xyte.report.v1"' >/dev/null
REPORT_META_PATH="$TMP_DIR/report-meta.json"
printf '%s\n' "$REPORT_OUTPUT" > "$REPORT_META_PATH"
"$VALIDATE_SCHEMA" "$REPO_ROOT/docs/schemas/report.v1.schema.json" "$REPORT_META_PATH"
[[ -s "$REPORT_PATH" ]]
echo "PASS report generation"

echo "Validating headless contract..."
"$SCRIPT_DIR/check_headless.sh" "$TENANT_ID"

echo "All agent contracts validated."
