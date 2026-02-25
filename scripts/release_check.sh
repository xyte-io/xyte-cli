#!/usr/bin/env bash

set -euo pipefail

echo "== release check: install =="
npm ci

echo "== release check: typecheck =="
npm run typecheck

echo "== release check: tests =="
npm test

echo "== release check: build =="
npm run build

echo "== release check: package dry-run =="
npm pack --dry-run

if command -v docker >/dev/null 2>&1; then
  echo "== release check: controlled upgrade smoke =="
  npm run smoke:upgrade:controlled
else
  echo "== release check: controlled upgrade smoke skipped (docker not found) =="
fi

echo "== release check: security audit (high/critical) =="
npm audit --audit-level=high

if [[ -n "${XYTE_CLI_KEY:-}" ]]; then
  echo "== release check: external live smoke =="
  npm run smoke:external-live
else
  echo "== release check: external live smoke skipped (XYTE_CLI_KEY not set) =="
fi
