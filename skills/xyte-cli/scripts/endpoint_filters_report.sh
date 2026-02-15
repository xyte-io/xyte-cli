#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SPEC="$REPO_ROOT/src/spec/public-endpoints.json"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

if [[ ! -f "$SPEC" ]]; then
  echo "Spec file not found: $SPEC" >&2
  exit 1
fi

echo "key | method | query_params | pagination"
echo "--- | --- | --- | ---"

jq -r '
  .[]
  | select((.queryParams | length) > 0)
  | {
      key,
      method,
      query: (.queryParams | join(", ")),
      pagination: (if ((.queryParams | index("page")) != null or (.queryParams | index("per_page")) != null)
                   then "page/per_page"
                   else "none"
                   end)
    }
  | "\(.key) | \(.method) | \(.query) | \(.pagination)"
' "$SPEC"
