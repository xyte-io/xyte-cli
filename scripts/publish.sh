#!/usr/bin/env bash

set -euo pipefail

MODE="${1:-all}"
REPO="${GITHUB_REPOSITORY:-xyte-io/xyte-cli}"
WORKFLOW="${PAGES_WORKFLOW:-pages.yml}"

usage() {
  cat <<'EOF'
Usage: scripts/publish.sh [cli|pages|all]

  cli    Publish @xyte/cli to npm
  pages  Trigger GitHub Pages deployment workflow
  all    Publish npm package, then trigger Pages deployment (default)
EOF
}

publish_cli() {
  echo "Checking npm auth..."
  npm whoami >/dev/null

  echo "Publishing @xyte/cli..."
  npm publish
}

publish_pages() {
  echo "Checking GitHub auth..."
  gh auth status >/dev/null

  echo "Triggering GitHub Pages workflow (${WORKFLOW}) for ${REPO}..."
  gh workflow run "${WORKFLOW}" --repo "${REPO}"

  echo "Pages workflow triggered. Monitor with:"
  echo "gh run list --repo ${REPO} --workflow ${WORKFLOW} --limit 1"
}

case "${MODE}" in
  -h|--help)
    usage
    ;;
  cli)
    publish_cli
    ;;
  pages)
    publish_pages
    ;;
  all)
    publish_cli
    publish_pages
    ;;
  *)
    usage
    exit 1
    ;;
esac
