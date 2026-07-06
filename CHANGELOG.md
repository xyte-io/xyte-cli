# Changelog

All notable changes to this project are documented in this file.

The format is inspired by Keep a Changelog and this project follows SemVer for `@xyteai/cli`.

## [Unreleased]

## [0.12.0] - 2026-07-06

### Added
- Added organization Edge model discovery to the endpoint catalog and typed client:
  - `organization.models.getModels`
  - `organization.models.getModel`
- Added `xyte-cli edge models list|describe` for read-only Edge model discovery. Model listing sends `edge_only=true` and supports explicit `page`, `per_page`, and `search` filters.
- Added safe already-claimed Edge custom-parameter update commands:
  - `xyte-cli edge update-params`
  - `xyte-cli edge update-params-batch`
- Added built-in flows for the new Edge workflows:
  - `flow.edge-model-discovery`
  - `flow.edge-params-update`
  - `flow.edge-params-update-batch`
- Added `flow.device-command` so agents fetch a device, read model command metadata, validate command params, and pause for approval before sending a command.
- Added utility preparation support for Edge parameter updates via `edge.params.update`.
- Added JSON schemas for Edge model discovery, Edge claim batch, and Edge params update outputs in both docs and the shipped `xyte-cli` skill bundle.
- Added GH Pages/user-facing guides for already-claimed Edge custom-parameter updates and refreshed Edge claim/model discovery guidance.

### Changed
- Updated `organization.devices.getDevices` metadata for `page`/`per_page` pagination and documented both `next_page` and `has_next_page` response shapes.
- Extended `edge claim` and `edge claim-batch` with optional `mac`, `sn`, and model-backed custom-parameter validation.
- Updated Edge claim workflows to discover Edge models before claim writes so operators can choose real model IDs and supported `custom_parameters` labels.
- Documented Edge `custom_parameters` updates as complete-replacement writes and routed operators through the safe Edge params commands instead of raw `updateDevice` loops.
- Updated command-send guidance, CLI/TUI preflight behavior, docs, and shipped skills to derive supported device commands from `organization.models.getModel.commands[]` instead of command history.
- Updated Markdown docs, GH Pages reference pages, and shipped skill guidance for Edge model discovery, Edge claim preparation, already-claimed Edge params updates, device command workflows, reports, resume artifacts, and approval gates.

### Fixed
- Edge claim batch model discovery now retries later rows after a transient model lookup failure instead of caching the failed lookup for the whole run.
- Edge params batch reports blank or missing `set_json` as `missing_set_json` while preserving `invalid_set_json` for malformed or non-object JSON.

### Upgrade notes
- Existing workspaces that already installed the shipped skill bundle should run `xyte-cli skills refresh` after upgrading so agents receive the new Edge model, params, claim, and device-command guidance.

## [0.11.0] - 2026-06-24

### Added
- Added organization note endpoints to the public endpoint catalog, typed client surface, docs, and shipped skill guidance:
  - `organization.notes.createDeviceNote`
  - `organization.notes.createSpaceNote`
  - `organization.notes.deleteDeviceNote`
  - `organization.notes.deleteSpaceNote`
  - `organization.notes.getAllDeviceNotes`
  - `organization.notes.getAllSpaceNotes`
  - `organization.notes.getDeviceNotes`
  - `organization.notes.getSpaceNotes`

## [0.10.8] - 2026-06-10

### Added
- `xyte-cli doctor environment`: environment diagnostics for install and setup. Checks Node version, writability (cwd, HOME, temp, config dir, workspace runtime), secret-store availability, and config-dir placement, then recommends an install mode (`existing` | `npx` | `workspace-local` | `blocked`) with copy-pasteable, platform-appropriate command recipes. Offline by default; `--check-network` probes npm registry reachability. New `xyte.doctor.environment.v1` contract in `docs/schemas/` with a byte-identical skill-bundle mirror.
- `xyte-cli skills refresh`: force-installs all agent skill bundles (project and user scope) in one command. Run it in each workspace after upgrading; `xyte-cli upgrade` text output now suggests it (upgrade continues to refresh user scope automatically).

### Changed
- The hidden API key prompt now states that input is hidden and confirms `Received N characters.` after entry, so a failed paste is visible immediately. Secret prompts never render default values.
- Text-mode errors now include the error detail and `Try:` suggested commands (previously only the summary line was printed; JSON error output is unchanged).
- Provider auto-detection failures carry actionable, install-mode-agnostic recovery suggestions.
- Onboarding docs and the GitHub Page are doctor-first with three explicit install paths: AI agent (paste the canonical prompt; the agent installs itself and asks for the path to a key file - never the key), CI/headless (`XYTE_CLI_KEY` secret), and manual terminal. The agent prompt is byte-identical across README, docs/agents.md, and the page.
- `--key-file` help and docs use the `<path-outside-workspace>` placeholder to reinforce that keys must not live inside the repo.

### Upgrade notes
- Existing workspaces keep their own skill bundle copies; run `xyte-cli skills refresh` to update them.

## [0.10.7] - 2026-06-01

### Added
- BE-1529: Documented the new `effective_status` response field on `organization.devices.getDevices`, `organization.devices.getDevice`, and `organization.devices.claimDevice` in the public endpoint catalog. The field is a nullable string with one of `ok`, `warning`, `error`, `offline`, `disconnected`, `never_seen`, computed from incident priority, connectivity, telemetry-seen state, and raw device status. Visible via `xyte-cli api endpoints describe <key>`.

## [0.10.6] - 2026-05-28

### Added
- Added organization device incident controls:
  - `organization.devices.suspendIncidents`
  - `organization.devices.resumeIncidents`
- Added organization edge discovery:
  - `organization.edges.getEdges`
- Added organization group management endpoints:
  - `organization.groups.createGroup`
  - `organization.groups.getGroups`
  - `organization.groups.getGroup`
  - `organization.groups.updateGroup`
  - `organization.groups.deleteGroup`
  - `organization.groups.addUsers`
  - `organization.groups.removeUsers`
  - `organization.groups.addExternalUser`
- Added organization user management endpoints:
  - `organization.users.createUser`
  - `organization.users.getUsers`
  - `organization.users.getUser`
  - `organization.users.deactivateUser`
  - `organization.users.resendWelcome`
- Added partner organization creation:
  - `partner.organizations.createOrganization`
- Updated the typed client namespace surface, endpoint catalog, command docs, endpoint reference docs, tests, and shipped `xyte-cli` skill data for the new endpoints.

### Fixed
- Corrected the Edge claim and ping lifecycle routes to use the deployed `/core/v1/organization/edges/devices/...` paths:
  - `organization.edge.startClaim`
  - `organization.edge.getClaimStatus`
  - `organization.edge.startPing`
  - `organization.edge.getPingStatus`

## [0.10.5] - 2026-05-12

### Fixed
- Corrected read endpoint metadata so organization command/ticket reads do not advertise request bodies and partner ticket reads use the callable ticket path without the docs copy suffix.

## [0.10.4] - 2026-05-11

### Fixed
- Added `User-Agent: CLI` to Xyte API requests sent by the CLI.

## [0.10.3] - 2026-04-29

### Added
- Added prepare-only `util prepare` normalization utilities for connector setup and team access groups, user invites, and memberships.
- Added shipped skill and docs guidance for using the new connector and team access normalization utilities without attaching nonexistent API execution paths.
- Added schema, CLI, and packaged-install smoke coverage for prepare-only utility actions.

### Fixed
- Corrected AI utility preprocessing docs and skill guidance for the generated `device.move` prepare headers.

## [0.10.2] - 2026-04-26

### Added
- Added `edge claim-batch --skip-connectivity-check` for batches that intentionally skip batch-owned pre-claim connectivity checks on blank rows.
- Added batch-owned pre-claim ping behavior for `edge claim-batch`: blank or `skip_connectivity_check=false` rows now run `edge ping` before `startClaim`; `skip_connectivity_check=true` rows skip the ping and send `true`.
- Added `ping-failed`, `preClaimPing`, and `totals.pingFailed` reporting so batch claim failures clearly distinguish connectivity probe failures from claim failures.
- Added `nextAction` hints to flow run summaries, `flow list --format text|json` discovery output, and non-interactive `logs show` lookup by entry or request id.

### Changed
- Updated `flow.edge-claim-batch`, docs, and the shipped `xyte-cli` skill guidance to describe plan-first batch claiming, resume artifacts, skip-connectivity precedence, and the row-result-only resume limitation.
- Changed utility batch dry-run reporting to count validated rows under `totals.planned` instead of `totals.succeeded`.
- Improved generated `util prepare` notes with a clearer column glossary, reject taxonomy, canonical JSON shape, and safe next commands.

### Fixed
- Fixed `edge claim-batch` so rows that require connectivity verification no longer call `startClaim` before the CLI has run and completed the corresponding Edge ping.
- Fixed batch resume handling so previously `succeeded` or `already-claimed` rows are skipped before skip-connectivity conflict checks.
- Fixed generated flow resume commands to include custom `--out-dir` values and use platform-appropriate argument quoting.
- Fixed malformed or missing flow resume metadata to fail closed instead of silently falling back to invocation defaults.
- Fixed global `--output` handling for `flow list` and `logs` commands when local `--format` was not explicitly provided.
- Fixed exact `logs show` lookups so they are not limited to the recent log tail.
- Added confirmation for `config tenant remove` and clarified removed profile/key-slot metadata in the command output.

## [0.10.1] - 2026-04-20

### Added
- `--key-command <command>` on `setup run`, `config key add`, and `config key update`: runs an arbitrary shell command and uses its stdout as the API key. Intended for resolving keys from external secret managers (`op read`, `vault kv get`, `aws secretsmanager get-secret-value`, `pass show`, …) without shell glue or wrapper processes. The command value is redacted from action logs.

### Fixed
- `--key-command` failures now distinguish command-startup errors from non-zero exits and report non-zero exits as the exit code only, so command stdout/stderr are not leaked in user-facing errors or action logs.

## [0.10.0] - 2026-04-20

### Added
- Added the Edge Devices API surface to the CLI catalog: `organization.edge.startClaim`, `organization.edge.getClaimStatus`, `organization.edge.startPing`, `organization.edge.getPingStatus` (async claim/ping lifecycle).
- Added the `xyte-cli edge` command group: `edge claim`, `edge claim-batch`, `edge claim-status`, `edge ping`, `edge ping-status` with plan/apply semantics, poll overrides, and resume artifacts.
- Added the `organization.edge.startClaim` utility-prepare profile with `proxy_id,device_ip,device_model_id,space_id,...` columns, deterministic primary/rejected/notes outputs, and a documented reject-reason taxonomy.
- Added three built-in flows: `flow.edge-claim`, `flow.edge-claim-batch` (the north-star bulk-claim workflow with resume), and `flow.edge-ping`.
- Added `docs/claim-devices.md`, a native-vs-edge-vs-C2C tutorial that codifies the mandatory disambiguation rule agents must ask, and the canonical C2C-unsupported response template.
- Added `skills/xyte-cli/references/claim-playbook.md` — single-doc claim playbook for agents covering both claim paths plus the 20-row edge-case decision tree.
- Added `scripts/sync_skills_data.mjs` and wired it into `npm run build` / `prepublishOnly` to keep `src/api-catalog/public-endpoints.json` and `skills/xyte-cli/data/public-endpoints.json` byte-identical.
- Native persisted secret storage on Linux via Secret Service, alongside macOS Keychain and Windows DPAPI.
- Secure-storage downgrade warnings that explain when `auth.secretStoreBackend=auto` falls back to file storage and how to require `native` or opt into `file`.
- Dedicated `windows-native-secret-store-cert` and `linux-native-secret-store-cert` CI jobs for native secure-storage validation.

### Changed
- `xyte-cli config path` now reports `secretStoreBackend`, `secretStore`, and `legacySecretStore` so callers can inspect the resolved credential backend.

### Removed
- Removed the committed `HANDOFF.md` root document.

## [0.9.0] - 2026-04-15

### Added
- Added `organization.devices.moveDevice` support to the public CLI endpoint catalog and typed client surface.
- Added `xyte-cli util move-devices` for batch device moves with dry-run/apply execution, duplicate detection, row-level validation, and NDJSON reports.
- Added the built-in `flow.device-migration` workflow to match devices, dry-run moves, execute approved moves, verify results, and generate migration reports.
- Added move-verification and migration-reporting contracts so post-move verification and operator-facing summaries can be generated from structured outputs.

### Fixed
- Fixed the move-device route used by the CLI to match the live organization API path at `/core/v1/organization/devices/:device_id/move`.
- Fixed `xyte-cli api call --output-mode` handling so invalid values fail fast instead of silently falling back to raw output.

## [0.8.0] - 2026-03-23

### Added
- `--key-file` support for `xyte-cli setup run`, `xyte-cli config key add`, and `xyte-cli config key update` so automation can load secrets from disk without putting raw keys on the command line.
- Tenant-profile migration that records an explicit `apiProvider`, purges invalid provider state, and keeps the active provider aligned when key slots are added, updated, or switched.

### Changed
- Split the CLI command surface into dedicated command modules with shared option parsing, output handling, and problem mapping across `setup`, `config`, `api`, `ops`, `flow`, `util`, and `logs`.
- Made provider-aware TUI and inspect/report loading strict against the tenant's stored provider instead of selecting a different provider at runtime.
- Updated shipped docs and `skills/xyte-cli` guidance to match the explicit-provider and `--key-file` flows.

### Fixed
- Fixed `xyte-cli upgrade` target-version installs so an explicit version override installs that version instead of falling back to `@latest`.
- Fixed offline setup, smoke-pack-install, and provider-specific setup flows to require and preserve explicit provider selection consistently.
- Fixed provider-state migration so legacy profiles are normalized before commands and TUI screens read tenant auth state.

### Breaking Changes
- `xyte-cli` no longer performs org-to-partner runtime fallback for setup, config, TUI data loading, or inspect/report flows. If a tenant can resolve to more than one provider, callers must choose the intended provider explicitly.
- `xyte-cli setup run --connectivity never` now requires an explicit `--provider` because offline setup no longer probes providers implicitly.

## [0.7.0] - 2026-03-20

### Added
- `--out` support for `xyte-cli ops inspect deep-dive`, `xyte-cli ops inspect fleet`, and `xyte-cli ops watch incidents` so report inputs and watch streams can be written directly as UTF-8 files.
- Shell-neutral setup flows with hidden key prompts, `setup run --key-stdin`, and `setup status --field tenantId`.
- Bundled schemas, templates, and reference data in the shipped `skills/xyte-cli` package so helper scripts can run from the installed package instead of a repo checkout.
- Cross-platform packaged-install smoke coverage for the published tarball on Ubuntu, macOS, and Windows.

### Changed
- Switched the published npm entrypoint to the direct Node launcher and raised the supported runtime floor to Node.js 22.
- Made `xyte-cli init` install skills first and treat missing credentials/setup as a next-step condition unless `--require-setup` is requested.
- Replaced Unix-only release helpers and shipped skill helper scripts with cross-platform Node-based implementations.
- Updated README, getting-started docs, flow recipes, and GitHub Pages to use the new `--out`, `--output json --strict-json`, and PATH-fallback guidance.

### Fixed
- Fixed global Windows installs so `xyte-cli` works in PowerShell and `cmd.exe` without Bash, Git Bash, or WSL.
- Fixed packaged-install smoke, `.cmd` spawning, and install verification on Windows by handling npm shim paths correctly.
- Fixed report-generation flows on Windows by removing shell-redirection dependence and preserving UTF-8 output files.
- Fixed `setup run --connectivity never` so it no longer performs tenant-name network inference before offline setup.
- Fixed broken GitHub Pages logo asset references so the docs site loads its brand images again.

## [0.6.0] - 2026-03-06

### Added
- Public v2 command surface built around `init`, `status`, `setup`, `config`, `api`, `ops`, `flow`, `util`, and `logs`.
- Layered settings resolution with user config, workspace config, normalized `XYTE_CLI_*` environment overrides, and `config show|set|unset|path`.
- Contextual root launcher output and structured user-facing problem details for setup, auth, and invalid command flows.
- Structured `overviewMetrics` in the deep-dive contract for report rendering without summary-text parsing.

### Changed
- Removed legacy top-level command wrappers from the public CLI surface in favor of the canonical v2 layout.
- Made `ops console` the canonical interactive entrypoint and aligned CLI, TUI, docs, skills, and GitHub Pages around the same operator vocabulary.
- Reworked report PDF presentation with a cleaner first page, calmer card styling, and stronger information hierarchy.
- Updated README, command docs, flow docs, GitHub Pages, and shipped skill packs to the v2 command model.
- Removed stale public demo videos and other tracked temp leftovers from the published tree.

### Fixed
- Preserved request ID correlation for flow `call` tasks between transport metadata and emitted envelopes.
- Hardened config path assignment against prototype-pollution style key paths.
- Fixed report parsing to avoid regex-based deep-dive summary extraction and the associated security finding.
- Fixed controlled upgrade smoke cancellation behavior and import-tree root-space resolution against live tenants.
- Closed remaining typecheck, smoke, and review regressions discovered during PR validation.

## [0.5.2] - 2026-02-25

### Added
- First-class deterministic flow runner:
  - `xyte-cli flow run <flow-id>` with safe default `--plan`.
  - gated progression with `--apply`.
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
