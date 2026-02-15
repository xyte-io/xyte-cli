#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

if [[ ! -x ./bin/xyte-cli ]]; then
  echo "xyte-cli binary wrapper not found at ./bin/xyte-cli" >&2
  exit 1
fi

./bin/xyte-cli "$@"
