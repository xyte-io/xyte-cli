# Release Guide

This repository ships one npm package: `@xyteai/cli`.

## Governance

- Versioning and release notes live in `/Users/porton/Projects/xyte-cli/CHANGELOG.md`.
- Security handling policy lives in `/Users/porton/Projects/xyte-cli/SECURITY.md`.
- JSON contracts in `docs/schemas/*.schema.json` are treated as the automation compatibility boundary.

## CI Gates

`/Users/porton/Projects/xyte-cli/.github/workflows/ci.yml` runs on pushes and pull requests:

- matrix validation on `ubuntu-latest` and `macos-latest`, Node `18` and `22`
- `npm ci`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm pack --dry-run`
- separate security job: `npm audit --audit-level=high`

Recommended branch protection:

- require `CI / validate`
- require `CI / security`
- require up-to-date branch before merge

## Local Pre-Release Check

Run the full local gate:

```bash
npm run release:check
```

This script runs install, typecheck, tests, build, dry-run pack, audit, and optional external smoke (`XYTE_CLI_KEY` required).

## Publish Workflow

`/Users/porton/Projects/xyte-cli/.github/workflows/publish.yml` publishes to npm on semver tags (`vX.Y.Z` or `X.Y.Z`) or manual dispatch.

Workflow gates:

1. Resolve and validate semver tag.
2. Checkout the exact tag commit.
3. Validate `package.json` version matches tag version.
4. Run `typecheck`, `test`, `build`, and `npm pack --dry-run`.
5. Publish to npm with provenance on Node `22` + npm `11.5.1`.

Prerequisites:

- npm package publish rights for `@xyteai/cli`.
- `NPM_TOKEN` configured in repository/environment secrets.

## Release Assets Workflow

`/Users/porton/Projects/xyte-cli/.github/workflows/release-assets.yml` runs on the same tags (or manually) and attaches release artifacts to GitHub Releases:

- built npm tarball (`*.tgz`)
- CycloneDX SBOM (`sbom.cdx.json`)
- SHA-256 checksums (`checksums.txt`)

## Manual Emergency Publish

If GitHub Actions is unavailable:

1. `npm run release:check`
2. Bump `package.json` version and update `CHANGELOG.md`.
3. `npm publish --access public --provenance`
4. Backfill release assets with `release-assets.yml` once actions are restored.

## Rollback / Recovery

- Prefer a fast patch release with a bumped patch version.
- Deprecate bad versions instead of unpublish:
  - `npm deprecate @xyteai/cli@<bad-version> "<message>"`
- Avoid unpublish except where npm policy allows.
