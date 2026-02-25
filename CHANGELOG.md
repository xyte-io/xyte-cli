# Changelog

All notable changes to this project are documented in this file.

The format is inspired by Keep a Changelog and this project follows SemVer for `@xyteai/cli`.

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
