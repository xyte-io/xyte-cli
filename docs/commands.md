# Command Reference

This page is a high-signal map of common commands. For full flags and subcommands, use `xyte-cli --help` and `<command> --help`.

## Flow Index

- [`flow.setup-readiness-10m`](flows/agent-ops.md#flowsetup-readiness-10m): establish install/readiness/connectivity baseline before ops.
- [`flow.incidents-delta-watch`](flows/agent-ops.md#flowincidents-delta-watch): stream incident snapshots and deltas as watch frames.
- [`flow.watch-to-triage`](flows/agent-ops.md#flowwatch-to-triage): convert watch output into inspect/report triage artifacts.
- [`flow.guided-remediation`](flows/agent-ops.md#flowguided-remediation): execute guarded org command/ticket/incident actions with verification.
- [`flow.bulk-claim-and-space-import`](flows/agent-ops.md#flowbulk-claim-and-space-import): preprocess, dry-run, then approve claim/import writes.
- [`flow.daily-deep-dive-report`](flows/agent-ops.md#flowdaily-deep-dive-report): produce daily deep-dive JSON and markdown report outputs.

## Core

```bash
xyte-cli install --skills [--scope project|user|both] [--agents all|claude|copilot|codex] [--force] [--no-setup]
xyte-cli doctor install --format json
xyte-cli status [--tenant <tenant-id>] [--mode fast|full] [--format json|text]
xyte-cli setup status --tenant <tenant-id> --format json
xyte-cli setup run [--non-interactive] [--tenant <tenant-id>] [--key <value>] [--connectivity auto|always|never]
xyte-cli config doctor --tenant <tenant-id> --format json
xyte-cli upgrade --check --format json
xyte-cli upgrade --yes --format json
xyte-cli --log-actions [--log-actions-verbose] status --tenant <tenant-id>
xyte-cli logs list [--path <path>] [--limit <n>] [--format text|json]
xyte-cli logs stats [--path <path>] [--format text|json]
xyte-cli logs gc [--path <path>] [--max-files <n>] [--max-age-days <days>] [--dry-run] [--format text|json]
xyte-cli logs view [--path <path>] [--limit <n>]
```

## Tenant And Auth Slots

```bash
xyte-cli tenant add <tenant-id> --name "Acme"
xyte-cli tenant use <tenant-id>
xyte-cli tenant list

xyte-cli auth key add --tenant <tenant-id> --provider xyte-org --name primary --key "<value>" --set-active
xyte-cli auth key list --tenant <tenant-id> --format json
xyte-cli auth key use --tenant <tenant-id> --provider xyte-org --slot primary
xyte-cli auth key update --tenant <tenant-id> --provider xyte-org --slot primary --key "<value>"
xyte-cli auth key rename --tenant <tenant-id> --provider xyte-org --slot primary --name prod-primary
xyte-cli auth key test --tenant <tenant-id> --provider xyte-org --slot prod-primary
xyte-cli auth key remove --tenant <tenant-id> --provider xyte-org --slot prod-primary --confirm
```

## Endpoint Operations

```bash
xyte-cli list-endpoints
xyte-cli describe-endpoint organization.devices.getDevices
xyte-cli call organization.devices.getDevices --tenant <tenant-id>
xyte-cli call organization.devices.getDevices --tenant <tenant-id> --output-mode envelope --strict-json
xyte-cli watch --tenant <tenant-id> --profile incidents-active --once
xyte-cli watch --tenant <tenant-id> --profile incidents-active --interval-ms 2000 --max-polls 10
```

Reliable incident fetch:

```bash
NOW=$(date +%s)
xyte-cli call organization.incidents.getIncidents \
  --tenant <tenant-id> \
  --query-json "{\"status\":\"active\",\"from\":0,\"to\":$NOW,\"page\":1,\"per_page\":100}"
```

Incident delta watch (NDJSON frames):

```bash
xyte-cli watch --tenant <tenant-id> --profile incidents-active --once
xyte-cli watch --tenant <tenant-id> --profile incidents-active --interval-ms 2000 --max-polls 10
```

Frame event types:

- `snapshot`: first poll with normalized incident set.
- `delta`: added/removed/updated changes versus previous successful poll.
- `heartbeat`: no changes detected.
- `error`: poll failed; baseline is preserved for the next successful poll.

## Guarded Writes

```bash
xyte-cli call organization.commands.sendCommand \
  --tenant <tenant-id> \
  --allow-write \
  --path-json '{"device_id":"DEVICE_ID"}' \
  --body-json '{"command":"reboot"}'

xyte-cli call organization.commands.cancelCommand \
  --tenant <tenant-id> \
  --allow-write \
  --confirm organization.commands.cancelCommand \
  --path-json '{"device_id":"DEVICE_ID","command_id":"COMMAND_ID"}'
```

## Utility Preprocess And Space Import

```bash
xyte-cli utility list-actions --format text

xyte-cli utility prepare \
  --action organization.devices.claimDevice \
  --input ./raw-claims.xlsx \
  --output-dir ./tmp

xyte-cli utility prepare \
  --action space.import-tree \
  --input ./raw-hierarchy.pdf \
  --output-dir ./tmp

xyte-cli space import-tree --tenant <tenant-id> --input ./tmp/space-import-tree.csv
xyte-cli space import-tree --tenant <tenant-id> --input ./tmp/space-import-tree.csv --apply --report ./space-import.apply.ndjson
```

## Insights And Reports

```bash
xyte-cli inspect fleet --tenant <tenant-id> --format json
xyte-cli inspect deep-dive --tenant <tenant-id> --window 24 --format json > /tmp/deep-dive.json
xyte-cli report generate --tenant <tenant-id> --input /tmp/deep-dive.json --out /tmp/xyte-report.pdf
```

## TUI And Headless

```bash
xyte-cli tui
xyte-cli tui --headless --screen dashboard --format json --once --tenant <tenant-id>
xyte-cli tui --headless --screen spaces --format json --follow --interval-ms 2000 --tenant <tenant-id>
```

## Action Log Environment Flags

`XYTE_LOG_ACTIONS` enables NDJSON logging.
`XYTE_LOG_ACTIONS_STDERR` independently controls stderr mirroring.
Set `XYTE_LOG_ACTIONS_MAX_FILES=1` to keep only the active file (no rotated history).

```bash
XYTE_LOG_ACTIONS=1
XYTE_LOG_ACTIONS_PATH=/tmp/xyte-cli.actions.ndjson
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
