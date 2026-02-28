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
xyte-cli setup run --non-interactive --tenant acme --provider xyte-org --connectivity auto
xyte-cli status --tenant acme --mode fast --format json
```

Notes:
- For partner-only onboarding, set `--provider xyte-partner`.
- For organization onboarding, if `--name` is omitted, setup attempts to populate tenant display name from `organization.getOrganizationInfo`.
- Explicit `--name` always overrides auto-detected tenant display name.

### 2) Run read-only fleet checks

```bash
xyte-cli inspect fleet --tenant acme --provider-scope auto --format json
xyte-cli inspect deep-dive --tenant acme --provider-scope auto --window 24 --format json > /tmp/deep-dive.json
```

### 3) Generate a report

```bash
xyte-cli report generate --tenant acme --input /tmp/deep-dive.json --out /tmp/xyte-report.pdf
```

Report behavior:
- Reports are data-driven (`data -> summary -> PDF`): only collected data is summarized and rendered.
- Partner deep-dive/report enrichment is best-effort and uses partner read endpoints; optional enrichment failures do not block report generation.
- Partner reports include a dedicated `Partner Highlights` block when partner enrichment data is available.

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

- Incident delta watch can emit NDJSON watch frames:

```bash
xyte-cli watch --tenant acme --profile incidents-active --interval-ms 2000 --max-polls 2 --strict-json
```

- Watch guardrails are enforced to protect API capacity:
  - `--interval-ms` minimum is `1000`.
  - default polling is bounded when `--max-polls` is omitted.
  - `--max-polls` hard cap is `3600`.

- CLI error output can be forced to machine-readable JSON with `--error-format json` (or `XYTE_ERROR_FORMAT=json`).
- Stable schema IDs:
  - `xyte.headless.frame.v1`
  - `xyte.call.envelope.v1`
  - `xyte.watch.frame.v1`
  - `xyte.inspect.fleet.v1`
  - `xyte.inspect.deep-dive.v1`
  - `xyte.report.v1`
  - `xyte.utility.batch.v1`
  - `xyte.utility.prepare.v1`
  - `xyte.status.v1`
  - `xyte.upgrade.check.v1`
  - `xyte.upgrade.result.v1`
  - `xyte.flow.run.v1`
- Schemas live in [`docs/schemas`](docs/schemas).

## Action Logging

- Enable real command lifecycle logging with `--log-actions` (writes NDJSON logs and mirrors action events to stderr for that invocation).
- Override the log file path with `--log-actions-path <path>`.
- Default payload is minimal (`commandPath`, lifecycle event, duration/exit status). Use `--log-actions-verbose` only when you need args/options detail.
- Rotation defaults: `10MB` per file, `5` files total (active + rotated).
- Set `XYTE_LOG_ACTIONS_MAX_FILES=1` to keep only the active file (no rotated history).
- Environment toggles (logging and stderr mirroring are separate when set via env):
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

## Common Workflows And Utilities

### Deterministic Flow Runner

Use deterministic flow packs when an agent/operator needs repeatable incident and remediation loops:

- [`flow.setup-readiness-10m`](docs/flows/agent-ops.md#flowsetup-readiness-10m): readiness and connectivity baseline.
- [`flow.incidents-delta-watch`](docs/flows/agent-ops.md#flowincidents-delta-watch): incident NDJSON delta streaming.
- [`flow.watch-to-triage`](docs/flows/agent-ops.md#flowwatch-to-triage): convert watch output into triage artifacts.
- [`flow.guided-remediation`](docs/flows/agent-ops.md#flowguided-remediation): guarded command/ticket/incident writes.
- [`flow.bulk-claim-and-space-import`](docs/flows/agent-ops.md#flowbulk-claim-and-space-import): preprocess + dry-run + apply for claim/import operations.
- [`flow.daily-deep-dive-report`](docs/flows/agent-ops.md#flowdaily-deep-dive-report): daily deep-dive and markdown reporting.

```bash
xyte-cli flow list
xyte-cli flow run flow.setup-readiness-10m --tenant acme --inspect-provider-scope auto --plan
xyte-cli flow run flow.guided-remediation --tenant acme --inspect-provider-scope auto --plan --context-json ./flow.ctx.json
xyte-cli flow run flow.guided-remediation --tenant acme --inspect-provider-scope organization --apply --allow-write --resume <run-id-or-path>
```

Utilities prepare and normalize inputs; flows orchestrate deterministic multi-step execution.

<details>
<summary>Toggle: flow run modes and gates</summary>

- `--plan` is the default and runs safe/read steps until the first explicit human gate.
- `--apply` only advances one gate per invocation and should be used with `--resume`.
- Mutating gate steps require `--allow-write`; otherwise the run pauses with a structured pending decision.
- `inspect`/`deep-dive` are provider-scope strict. `auto` selects the only configured scope, and fails if both `xyte-org` and `xyte-partner` are configured.

</details>

Each run writes a deterministic bundle under `./tmp/flow-runs/<flow-id>/<timestamp>-<run-id>/`:
- `manifest.json` (run summary, resume pointer, classifications)
- `inputs.json` (resolved inputs/context)
- `steps/*` and `outputs/*` (per-step artifacts)
- `watch-frames.ndjson`, `decisions.ndjson`, `errors.ndjson`

Custom flow authoring guide:
- [`docs/flows/custom-workflows.md`](docs/flows/custom-workflows.md)

Custom flows are shareable aliases over built-ins:

```bash
xyte-cli flow create flow.noc-guided-remediation --based-on flow.guided-remediation --title "NOC Guided Remediation" --var device_id=DEVICE_ID --var ticket_id=TICKET_ID --var incident_id=INCIDENT_ID
xyte-cli flow edit flow.noc-guided-remediation --description "Pinned context defaults for NOC shift handoff"
xyte-cli flow share flow.noc-guided-remediation --out ./tmp/flow.noc-guided-remediation.json
xyte-cli flow import --file ./tmp/flow.noc-guided-remediation.json
```

<details>
<summary>Toggle: custom workflow lifecycle details</summary>

Create:
`xyte-cli flow create <custom-flow-id> --based-on <built-in-flow-id> [--title ...] [--description ...] [--context-json ...] [--var key=value ...]`

Edit:
`xyte-cli flow edit <custom-flow-id> [--based-on ...] [--title ...] [--description ...] [--context-json ...] [--var key=value ...] [--replace-defaults]`

Share/import:
`xyte-cli flow share <custom-flow-id> --out <path>`
`xyte-cli flow import --file <path> [--force]`

</details>

GitHub docs for authoring and examples:
- [`docs/flows/custom-workflows.md`](https://github.com/xyte-io/xyte-cli/blob/main/docs/flows/custom-workflows.md)
- [`docs/flows/agent-ops.md`](https://github.com/xyte-io/xyte-cli/blob/main/docs/flows/agent-ops.md)

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

### Incident delta watch

```bash
xyte-cli watch --tenant acme --profile incidents-active --once
xyte-cli watch --tenant acme --profile incidents-active --interval-ms 2000 --max-polls 10
```

### Utility Prepare Pipelines (AI-assisted preprocess, CLI-executed operations)

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
- Agent ops flow pack: [`docs/flows/agent-ops.md`](docs/flows/agent-ops.md)
- Custom workflow authoring: [`docs/flows/custom-workflows.md`](docs/flows/custom-workflows.md)
- Agent usage patterns: [`docs/agents.md`](docs/agents.md)
- Development and test gates: [`docs/development.md`](docs/development.md)
- Utility AI preprocess runbook: [`docs/ai-utility-preprocessing.md`](docs/ai-utility-preprocessing.md)
- Release process: [`docs/release.md`](docs/release.md)

## Compatibility Policy

- Stable automation boundary: schema-versioned JSON outputs in `docs/schemas/*`.
- Breaking command/contract changes are documented in `CHANGELOG.md`.
- During `0.x`, breaking changes may still occur and are called out in release notes.
