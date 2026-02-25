# Changelog

All notable changes to this project are documented in this file.

The format is inspired by Keep a Changelog and this project follows SemVer for `@xyteai/cli`.

## [Unreleased]

### Added
- New `xyte-cli watch` command (incidents-only profile) for continuous incident delta monitoring.
- New watch frame contract and schema:
  - `xyte.watch.frame.v1`
  - `docs/schemas/watch-frame.v1.schema.json`
- Contract and CLI coverage for snapshot/delta/heartbeat/error watch frames.

## [0.5.0] - 2026-02-25

### Added
- New `xyte-cli status` command for fast/full readiness checks with contract output `xyte.status.v1`.
- New `xyte-cli upgrade` command with `--check` and `--yes`, including user-scope skills refresh.
- Controlled upgrade smoke workflow and scripts to validate deterministic tarball A -> tarball B upgrades in CI.
- New status/upgrade schemas and contract validation coverage:
  - `xyte.status.v1`
  - `xyte.upgrade.check.v1`
  - `xyte.upgrade.result.v1`

### Changed
- Extended `xyte-cli setup run` with `--connectivity auto|always|never` and deterministic setup `steps` in JSON output.
- Hardened release checks to include controlled upgrade smoke when Docker is available.
- Updated docs and GitHub Pages content for new status/upgrade/setup behaviors.
- Removed `xyte-device` provider and device-scope API surface (`device.*` catalog entries, `device` auth scope, `client.device`, and `auth.device`).
- Added automatic cleanup for legacy `xyte-device` profile slots and secret-store records during read/normalization.

### Fixed
- Corrected semantic version comparison for upgrade check paths.
- Removed non-existent endpoint surface `organization.devices.updateDevice` from namespace/spec and related references.

## [0.4.0] - 2026-02-25

### Changed
- Removed MCP transport and command surface from `xyte-cli` (`xyte-cli mcp serve` no longer exists).
- Added CI matrix validation and security audit jobs.
- Hardened npm publish workflow with typecheck, test, build, and package gate checks.
- Added release-assets workflow to attach package tarball, SBOM, and checksums to GitHub releases.
- Added `release:check` script for local pre-release gating.
- Added golden contract regression tests for core JSON outputs.
- Added redaction for sensitive values in text and JSON error surfaces.
- Added governance docs (`SECURITY.md`, release governance updates) and compatibility policy notes.

## [0.3.2] - 2026-02-25

### Changed
- Removed the `mcp` command surface from `xyte-cli`.
- Removed MCP implementation, tests, docs, and skill references from this package.
- Kept the package scope focused on CLI, TUI, and headless JSON workflows.

## [0.3.1] - 2026-02-24

### Added
- Utility preprocessing contracts and scaffolding flow (`utility prepare`).
- Space import-tree dry-run/apply workflow with structured batch output.

### Changed
- Improved report rendering fidelity for markdown and PDF outputs.

## [0.1.0] - 2026-02-15

### Added
- Initial public release of `@xyteai/cli`.
- Auth/profile setup flows, endpoint calls, TUI, and headless contract output.
