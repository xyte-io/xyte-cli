# Command Reference: Workflows + Utilities

This page is a high-signal map of common commands. For full flags and subcommands, use `xyte-cli --help` and `<command> --help`.
Use it as a unified map for flow runner execution, utility pipelines, and endpoint operations.

## Built-In Flow Index

- [`flow.setup-readiness-10m`](flows/agent-ops.md#flowsetup-readiness-10m): establish install/readiness/connectivity baseline before ops.
- [`flow.incidents-delta-watch`](flows/agent-ops.md#flowincidents-delta-watch): stream incident snapshots and deltas as watch frames.
- [`flow.watch-to-triage`](flows/agent-ops.md#flowwatch-to-triage): convert watch output into inspect/report triage artifacts.
- [`flow.guided-remediation`](flows/agent-ops.md#flowguided-remediation): execute org command/ticket/incident actions with verification.
- [`flow.daily-deep-dive-report`](flows/agent-ops.md#flowdaily-deep-dive-report): produce daily deep-dive JSON and markdown report outputs.

## Flow Commands

```bash
xyte-cli flow list
xyte-cli flow run <flow-id> --tenant <tenant-id> [--plan|--apply] [--resume <run-id-or-path>] [--out-dir <path>] [--inspect-provider-scope organization|partner|auto] [--context-json <path>] [--var key=value ...] [--once] [--strict-json]
```

Notes:
- `--plan` is the default mode; `--plan` and `--apply` are mutually exclusive.
- `--apply` advances one human gate per invocation and should be paired with `--resume`.
- run bundles are written to `./tmp/flow-runs` by default and return `xyte.flow.run.v1` summary JSON on stdout.
- full authoring walkthrough: [`flows/custom-workflows.md`](flows/custom-workflows.md).

Custom flow lifecycle:

```bash
xyte-cli flow create <flow-id> --based-on <built-in-flow-id> [--title <title>] [--description <text>] [--context-json <path>] [--var key=value ...] [--force]
xyte-cli flow edit <flow-id> [--based-on <built-in-flow-id>] [--title <title>] [--description <text>] [--context-json <path>] [--var key=value ...] [--replace-defaults]
xyte-cli flow share <flow-id> --out <path>
xyte-cli flow import --file <path> [--force]
```

## Core

```bash
xyte-cli init [--scope project|user|both] [--agents all|claude|copilot|codex] [--force] [--no-setup] [--require-setup]
xyte-cli status [--tenant <tenant-id>] [--mode fast|full] [--output json|text]
xyte-cli setup status [--tenant <tenant-id>] [--output json] [--field tenantId]
xyte-cli setup run [--non-interactive] [--tenant <tenant-id>] [--name <display-name>] [--provider xyte-org|xyte-partner] [--key <value>|--key-stdin] [--connectivity auto|always|never]
xyte-cli config doctor --tenant <tenant-id> --output json
xyte-cli upgrade --check --output json
xyte-cli upgrade --yes --output json
xyte-cli --log-actions [--log-actions-verbose] status --tenant <tenant-id>
xyte-cli logs list [--path <path>] [--limit <n>] [--output text|json]
xyte-cli logs stats [--path <path>] [--output text|json]
xyte-cli logs gc [--path <path>] [--max-files <n>] [--max-age-days <days>] [--dry-run] [--output text|json]
xyte-cli logs view [--path <path>] [--limit <n>]
```

Setup notes:
- Interactive `xyte-cli setup run` is the primary human onboarding path.
- Piping a key on stdin into `xyte-cli setup run --key-stdin` is the primary shell-neutral automation path.
- `xyte-cli setup status --field tenantId` is the primary shell-neutral extractor for follow-up commands.
- Use `--provider xyte-partner` for partner-only tenants.
- For `xyte-org`, when `--name` is omitted, setup attempts to populate tenant display name from `organization.getOrganizationInfo`.
- Explicit `--name` always takes precedence over auto-detected names.

## Tenant And Auth Slots

```bash
xyte-cli config tenant add <tenant-id> --name "Acme"
xyte-cli config tenant use <tenant-id>
xyte-cli config tenant list

xyte-cli config key add --tenant <tenant-id> --provider xyte-org --name primary --key "<value>" --set-active
xyte-cli config key list --tenant <tenant-id> --output json
xyte-cli config key use --tenant <tenant-id> --provider xyte-org --slot primary
xyte-cli config key update --tenant <tenant-id> --provider xyte-org --slot primary --key "<value>"
xyte-cli config key rename --tenant <tenant-id> --provider xyte-org --slot primary --name prod-primary
xyte-cli config key test --tenant <tenant-id> --provider xyte-org --slot prod-primary
xyte-cli config key remove --tenant <tenant-id> --provider xyte-org --slot prod-primary --confirm
```

Auth note:
- Inline `--key "<value>"` examples are shell-sensitive. Prefer `setup run --key-stdin` for cross-platform onboarding and automation.

## Endpoint Operations

```bash
xyte-cli api endpoints list
xyte-cli api endpoints describe organization.devices.getDevices
xyte-cli api call organization.devices.getDevices --tenant <tenant-id>
xyte-cli api call organization.devices.getDevices --tenant <tenant-id> --output-mode envelope --strict-json
xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once
xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --interval-ms 2000 --max-polls 10
```

Watch guardrails:
- `--interval-ms` minimum is `1000`.
- default watch loops are bounded when `--max-polls` is omitted.
- `--max-polls` hard cap is `3600`.
- terminal output is text by default; add `--output json --strict-json` when you want machine-readable frames.

Reliable incident fetch:

Advanced shell-specific fallback. The integer timestamp expression varies by shell; use a native equivalent in PowerShell or CMD.

```bash
NOW=$(date +%s)
xyte-cli api call organization.incidents.getIncidents \
  --tenant <tenant-id> \
  --query-json "{\"status\":\"active\",\"from\":0,\"to\":$NOW,\"page\":1,\"per_page\":100}"
```

Incident delta watch:

```bash
xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once
xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --interval-ms 2000 --max-polls 10
xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --output json --strict-json
```

Frame event types:

- `snapshot`: first poll with normalized incident set.
- `delta`: added/removed/updated changes versus previous successful poll.
- `heartbeat`: no changes detected.
- `error`: poll failed; baseline is preserved for the next successful poll.

## Write Examples

These raw API examples are shell-specific because inline JSON quoting differs across shells.

```bash
xyte-cli api call organization.commands.sendCommand \
  --tenant <tenant-id> \
  --path-json '{"device_id":"DEVICE_ID"}' \
  --body-json '{"command":"reboot"}'

xyte-cli api call organization.commands.cancelCommand \
  --tenant <tenant-id> \
  --path-json '{"device_id":"DEVICE_ID","command_id":"COMMAND_ID"}'
```

## Utility Pipelines And Space Import

```bash
xyte-cli util list-actions --output text

xyte-cli util prepare \
  --action organization.devices.claimDevice \
  --input ./raw-claims.xlsx \
  --output-dir ./prepared

xyte-cli util prepare \
  --action space.import-tree \
  --input ./raw-hierarchy.pdf \
  --output-dir ./prepared

xyte-cli util import-tree --tenant <tenant-id> --input ./prepared/space-import-tree.csv
xyte-cli util import-tree --tenant <tenant-id> --input ./prepared/space-import-tree.csv --apply --report ./reports/space-import.apply.ndjson
```

## Insights And Reports

```bash
xyte-cli ops inspect fleet --tenant <tenant-id> --provider-scope auto --output json
xyte-cli ops inspect deep-dive --tenant <tenant-id> --provider-scope auto --window 24 --output json --out ./artifacts/deep-dive.json
xyte-cli ops report generate --tenant <tenant-id> --input ./artifacts/deep-dive.json --out ./reports/xyte-report.pdf
```

Provider scope behavior:
- `--provider-scope auto` selects the only configured credential scope.
- If both `xyte-org` and `xyte-partner` are configured, `auto` fails and requires explicit `organization` or `partner`.
- Inspect pipelines are scope-strict: organization mode does not call partner endpoints, and partner mode does not call organization endpoints.
- Partner deep-dive/report enrichment is best-effort; optional partner enrichment endpoint failures do not block report generation.
- Partner reports include `Partner Highlights` when partner enrichment data is available.

## Console And Headless

```bash
xyte-cli ops console
xyte-cli ops console --headless --screen dashboard --output json --once --tenant <tenant-id>
xyte-cli ops console --headless --screen spaces --output json --follow --interval-ms 2000 --tenant <tenant-id>
```

## Action Log Environment Flags

Primary explicit-path workflow:

```bash
xyte-cli --log-actions --log-actions-path ./logs/xyte-cli.actions.ndjson status --tenant <tenant-id>
xyte-cli logs list --path ./logs/xyte-cli.actions.ndjson --limit 200
xyte-cli logs stats --path ./logs/xyte-cli.actions.ndjson
```

Advanced shell-specific environment flags:

`XYTE_LOG_ACTIONS` enables NDJSON logging.
`XYTE_LOG_ACTIONS_STDERR` independently controls stderr mirroring.
Set `XYTE_LOG_ACTIONS_MAX_FILES=1` to keep only the active file (no rotated history).

```bash
XYTE_LOG_ACTIONS=1
XYTE_LOG_ACTIONS_PATH=./logs/xyte-cli.actions.ndjson
XYTE_LOG_ACTIONS_STDERR=1
XYTE_LOG_ACTIONS_VERBOSE=1
XYTE_LOG_ACTIONS_MAX_FILE_BYTES=10485760
XYTE_LOG_ACTIONS_MAX_FILES=5
```

Interactive hotkeys on ops screens:

- `a`: action palette
- `f`: structured filter editor
- `[` / `]`: pagination where supported
- `p`: per-page size where supported
