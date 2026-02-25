# xyte-cli

Deterministic Xyte operations for agents and operators: CLI, full TUI, and headless JSON snapshots.

- Changelog: [`CHANGELOG.md`](CHANGELOG.md)
- Security policy: [`SECURITY.md`](SECURITY.md)
- Release guide: [`docs/release.md`](docs/release.md)

## Install

```bash
npm install -g @xyteai/cli@latest
xyte-cli --help
```

## Quick Start

### 1) Configure a tenant + key

```bash
XYTE_CLI_KEY="<your-key>" \
xyte-cli setup run --non-interactive --tenant acme --connectivity auto
xyte-cli status --tenant acme --mode fast --format json
```

### 2) Run read-only fleet checks

```bash
xyte-cli inspect fleet --tenant acme --format json
xyte-cli inspect deep-dive --tenant acme --window 24 --format json > /tmp/deep-dive.json
```

### 3) Generate a report

```bash
xyte-cli report generate --tenant acme --input /tmp/deep-dive.json --out /tmp/xyte-report.pdf
```

### 4) Run headless snapshots for agents

```bash
xyte-cli tui --headless --screen dashboard --once --format json --tenant acme
```

## Safety Model

- Write endpoints require `--allow-write`.
- Destructive endpoints require `--allow-write` and `--confirm <endpoint-key>`.
- `tui --headless` is read-only snapshot mode.
- `space import-tree` is dry-run by default; writes require `--apply`.

Example guarded write:

```bash
xyte-cli call organization.commands.sendCommand \
  --tenant acme \
  --allow-write \
  --path-json '{"device_id":"DEVICE_ID"}' \
  --body-json '{"command":"reboot"}'
```

## Output Modes And Contracts

- Human-readable and JSON-first workflows are both supported.
- Endpoint calls can emit envelope contracts:

```bash
xyte-cli call organization.devices.getDevices --tenant acme --output-mode envelope --strict-json
```

- CLI error output can be forced to machine-readable JSON with `--error-format json` (or `XYTE_ERROR_FORMAT=json`).
- Stable schema IDs:
  - `xyte.headless.frame.v1`
  - `xyte.call.envelope.v1`
  - `xyte.inspect.fleet.v1`
  - `xyte.inspect.deep-dive.v1`
  - `xyte.report.v1`
  - `xyte.utility.batch.v1`
  - `xyte.utility.prepare.v1`
  - `xyte.status.v1`
  - `xyte.upgrade.check.v1`
  - `xyte.upgrade.result.v1`
- Schemas live in [`docs/schemas`](docs/schemas).

## Action Logging

- Enable real command lifecycle logging with `--log-actions` (writes NDJSON logs and mirrors action events to stderr).
- Override the log file path with `--log-actions-path <path>`.
- Default payload is minimal (`commandPath`, lifecycle event, duration/exit status). Use `--log-actions-verbose` only when you need args/options detail.
- Rotation defaults: `10MB` per file, `5` files total (active + rotated).
- Environment toggles:
  - `XYTE_LOG_ACTIONS=1`
  - `XYTE_LOG_ACTIONS_PATH=/abs/path/cli-actions.ndjson`
  - `XYTE_LOG_ACTIONS_STDERR=1`
  - `XYTE_LOG_ACTIONS_VERBOSE=1`
  - `XYTE_LOG_ACTIONS_MAX_FILE_BYTES=10485760`
  - `XYTE_LOG_ACTIONS_MAX_FILES=5`

Examples:

```bash
xyte-cli --log-actions --log-actions-path /tmp/xyte-cli.actions.ndjson status --tenant acme
xyte-cli --log-actions --log-actions-verbose call organization.devices.getDevices --tenant acme
xyte-cli logs list --path /tmp/xyte-cli.actions.ndjson --limit 200
xyte-cli logs stats --path /tmp/xyte-cli.actions.ndjson
xyte-cli logs gc --path /tmp/xyte-cli.actions.ndjson --max-files 3 --max-age-days 14 --dry-run
xyte-cli logs view --path /tmp/xyte-cli.actions.ndjson
```

## Common Workflows

### Skills install for coding agents

```bash
xyte-cli install --skills
```

### Upgrade CLI + refresh user skills

```bash
xyte-cli upgrade --check --format json
xyte-cli upgrade --yes --format json
```

### Endpoint discovery + call

```bash
xyte-cli list-endpoints
xyte-cli describe-endpoint organization.devices.getDevices
xyte-cli call organization.devices.getDevices --tenant acme
```

### Utility prepare (AI-assisted preprocess, CLI-executed operations)

```bash
xyte-cli utility list-actions --format text
xyte-cli utility prepare --action organization.devices.claimDevice --input ./raw-source.xlsx --output-dir ./tmp
```

`xyte-cli` does not embed AI; external AI may preprocess files, then execution remains explicit via CLI commands.

### Space tree import

```bash
xyte-cli space import-tree --tenant acme --input ./tmp/space-import-tree.csv
xyte-cli space import-tree --tenant acme --input ./tmp/space-import-tree.csv --apply --report ./space-import.apply.ndjson
```

## Documentation Map

- Getting started and setup: [`docs/getting-started.md`](docs/getting-started.md)
- Command reference: [`docs/commands.md`](docs/commands.md)
- Agent usage patterns: [`docs/agents.md`](docs/agents.md)
- Development and test gates: [`docs/development.md`](docs/development.md)
- Utility AI preprocess runbook: [`docs/ai-utility-preprocessing.md`](docs/ai-utility-preprocessing.md)
- Release process: [`docs/release.md`](docs/release.md)

## Compatibility Policy

- Stable automation boundary: schema-versioned JSON outputs in `docs/schemas/*`.
- Breaking command/contract changes are documented in `CHANGELOG.md`.
- During `0.x`, breaking changes may still occur and are called out in release notes.
