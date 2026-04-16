# Release Guide

## Node.js versions and CI support

This project targets **Node.js 22** as its primary runtime environment.

- The `engines` field in `package.json` requires **Node.js >=22**.
- Our CI workflow currently runs the test suite on **Node.js 22.x** only.
- Earlier Node.js releases, including **Node 18**, are no longer supported.

This repository ships one npm package: `@xyteai/cli`.

## Governance

- Versioning and release notes live in `CHANGELOG.md`.
- Security handling policy lives in `SECURITY.md`.
- JSON contracts in `docs/schemas/*.schema.json` are treated as the automation compatibility boundary.

## CI Gates

`.github/workflows/ci.yml` runs on pushes and pull requests:

- matrix validation on `ubuntu-latest`, `macos-latest`, and `windows-latest`, Node `22`
- `npm ci`
- `npm run typecheck`
- `npm test`
- `npm run build`
- packaged-install smoke from the built tarball (`npm run smoke:pack-install`)
- Windows native secret-store certification (`windows-native-secret-store-cert`)
- Linux native secret-store certification (`linux-native-secret-store-cert`)
- separate security job: `npm audit --audit-level=high`
- controlled upgrade smoke job: `npm run smoke:upgrade:controlled` on `ubuntu-latest`

Recommended branch protection:

- require `CI / validate`
- require `CI / packaged-install-smoke`
- require `CI / security`
- require `CI / upgrade-controlled-smoke`
- require up-to-date branch before merge

## Local Pre-Release Check

Run the full local gate:

```bash
npm run release:check
```

This script runs install, typecheck, tests, build, packaged-install smoke, audit, and optional external smoke (`XYTE_CLI_KEY` required).

## Publish Workflow

`.github/workflows/publish.yml` publishes to npm on semver tags (`vX.Y.Z` or `X.Y.Z`) or manual dispatch.

Workflow gates:

1. Resolve and validate semver tag.
2. Checkout the exact tag commit.
3. Validate `package.json` version matches tag version.
4. Run `typecheck`, `test`, `build`, and the same packaged-install smoke used in CI.
5. Publish to npm with provenance on Node `22` + npm `11.5.1`.

Prerequisites:

- npm package publish rights for `@xyteai/cli`.
- `NPM_TOKEN` configured in repository/environment secrets.

## Release Assets Workflow

`.github/workflows/release-assets.yml` runs on the same tags (or manually) and attaches release artifacts to GitHub Releases:

- the same packaged-install smoke validates the tarball before attach/upload steps
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
