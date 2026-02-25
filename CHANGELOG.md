# Changelog

All notable changes to this project are documented in this file.

The format is inspired by Keep a Changelog and this project follows SemVer for `@xyteai/cli`.

## [Unreleased]

## [0.5.2] - 2026-02-25

### Added
- First-class deterministic flow runner:
  - `xyte-cli flow run <flow-id>` with safe default `--plan`.
  - guarded progression with `--apply --allow-write`.
  - resumable execution via `--resume <run-id-or-path>`.
  - structured artifact bundles under `./tmp/flow-runs/...`.
- Flow discovery and lifecycle commands:
  - `xyte-cli flow list`
  - `xyte-cli flow create`
  - `xyte-cli flow edit`
  - `xyte-cli flow share`
  - `xyte-cli flow import`
- New flow-run contract and schema:
  - `xyte.flow.run.v1`
  - `docs/schemas/flow-run.v1.schema.json`
- Built-in executable flow catalog for:
  - `flow.setup-readiness-10m`
  - `flow.incidents-delta-watch`
  - `flow.watch-to-triage`
  - `flow.guided-remediation`
  - `flow.bulk-claim-and-space-import`
  - `flow.daily-deep-dive-report`
- Doc-sync regression test enforcing exact recipe parity between `docs/flows/agent-ops.md` and the built-in flow catalog.

### Changed
- Updated agent/operator docs to prefer deterministic flow execution (`flow run`) for multi-step operations.
- Added executable-flow guidance in flow docs and skill routing.
- Hardened watch polling defaults and caps to prevent unbounded API pressure.

### Fixed
- Enforced stricter watch limits:
  - minimum `--interval-ms` is now `1000`.
  - default bounded polling when `--max-polls` is omitted.
  - maximum `--max-polls` is now `3600`.

## [0.5.1] - 2026-02-25

### Added
- Action lifecycle logging and `xyte-cli logs` commands (`list`, `view`, `stats`, `gc`).
- `xyte-cli watch` (incidents-only profile) with watch frame contract `xyte.watch.frame.v1`.
- Org-scope `organization.devices.updateDevice` endpoint mapping and coverage.
- AI Agent Ops flow-pack docs/skills routing and local `smoke:local:flow-pack` checks.

### Changed
- Removed `xyte-device` provider and device-scope API surface (`device.*` catalog entries, `device` auth scope, `client.device`, and `auth.device`).
- Automatic cleanup for legacy `xyte-device` profile slots and secret-store records during normalization.
- Expanded `utility prepare` command guidance for `sendCommand`, `claimDevice`, and `updateDevice` verification flows.

### Fixed
- Improved HTTP transport raw error surfaces to include upstream API detail payloads.

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
