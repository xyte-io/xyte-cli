# Command Reference: Workflows + Utilities

This page is a high-signal map of common commands. For full flags and subcommands, use `xyte-cli --help` and `<command> --help`.
Use it as a unified map for flow runner execution, utility pipelines, and endpoint operations.

## Built-In Flow Index

- [`flow.setup-readiness-10m`](flows/agent-ops.md#flowsetup-readiness-10m): establish install/readiness/connectivity baseline before ops.
- [`flow.incidents-delta-watch`](flows/agent-ops.md#flowincidents-delta-watch): stream incident snapshots and deltas as watch frames.
- [`flow.watch-to-triage`](flows/agent-ops.md#flowwatch-to-triage): convert watch output into inspect/report triage artifacts.
- [`flow.guided-remediation`](flows/agent-ops.md#flowguided-remediation): execute org command/ticket/incident actions with verification.
- [`flow.device-migration`](flows/agent-ops.md#flowdevice-migration): inventory, match, dry-run, execute, and verify device migration.
- [`flow.daily-deep-dive-report`](flows/agent-ops.md#flowdaily-deep-dive-report): produce daily deep-dive JSON and markdown report outputs.
- [`flow.edge-claim`](flows/agent-ops.md#flowedge-claim): claim a single edge device end-to-end (async start + poll).
- [`flow.edge-claim-batch`](flows/agent-ops.md#flowedge-claim-batch): bulk-claim edge devices from a prepared CSV with plan/apply and resume.
- [`flow.edge-ping`](flows/agent-ops.md#flowedge-ping): async connectivity probe for a device behind an Edge proxy.

## Flow Commands

```bash
xyte-cli flow list [--format json|text]
xyte-cli flow run <flow-id> --tenant <tenant-id> [--plan|--apply] [--resume <run-id-or-path>] [--out-dir <path>] [--inspect-provider-scope organization|partner|auto] [--context-json <path>] [--var key=value ...] [--once] [--strict-json]
```

Notes:
- `--plan` is the default mode; `--plan` and `--apply` are mutually exclusive.
- `flow list --format text` shows required context keys and the safe first `flow run ... --plan` command.
- `--apply --resume <run-id-or-path>` advances one human gate per invocation.
- run bundles are written to `./tmp/flow-runs` by default and return `xyte.flow.run.v1` summary JSON on stdout.
- non-completed run summaries include `nextAction`; use it as the primary operator hint before inspecting raw step data.
- malformed resume metadata fails closed; fix the run bundle or start a fresh run.
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
xyte-cli init [--target <path>] [--scope project|user|both] [--agents all|claude|copilot|codex] [--force] [--no-setup] [--require-setup]
xyte-cli status [--tenant <tenant-id>] [--mode fast|full] [--output json|text]
xyte-cli setup status [--tenant <tenant-id>] [--output json] [--field tenantId]
xyte-cli setup run [--non-interactive] [--advanced] [--tenant <tenant-id>] [--name <display-name>] [--provider xyte-org|xyte-partner] [--key <value>|--key-file <path>|--key-stdin|--key-command <cmd>] [--connectivity auto|always|never]
xyte-cli config show [--scope user|workspace|resolved] [--output json|text]
xyte-cli config path [--output json|text]
xyte-cli config set <key> <value> [--scope user|workspace]
xyte-cli config unset <key> [--scope user|workspace]
xyte-cli config doctor --tenant <tenant-id> --output json
xyte-cli doctor install [--format json|text]
xyte-cli upgrade --check --output json
xyte-cli upgrade --yes --output json
xyte-cli --log-actions [--log-actions-verbose] status --tenant <tenant-id>
xyte-cli logs list [--path <path>] [--limit <n>] [--event <event>] [--command <text>] [--session-id <id>] [--output text|json]
xyte-cli logs show [--path <path>] (--entry <sessionId:seq>|--request-id <id>) [--output text|json]
xyte-cli logs stats [--path <path>] [--output text|json]
xyte-cli logs gc [--path <path>] [--max-files <n>] [--max-age-days <days>] [--dry-run] [--output text|json]
xyte-cli logs view [--path <path>] [--limit <n>]
```

Log lookup notes:
- Use `logs list --session-id <id>` to narrow a run.
- Use `logs show --entry <sessionId>:<seq>` when you have an exact row id.
- Use `logs show --request-id <id>` to correlate API request logs; the command fails if the request id is missing or matches more than one entry.

Setup notes:
- Interactive `xyte-cli setup run` is the primary human onboarding path.
- `--key-file <path>` is the primary file-based automation path when the key already exists on disk.
- Piping a key on stdin into `xyte-cli setup run --key-stdin` is the primary shell-neutral automation path.
- `--key-command "<cmd>"` runs a shell command and uses its stdout as the API key. Use this to resolve keys from secret managers without shell glue — for example `--key-command "op read op://Employee/Xyte/credential"` (1Password), `--key-command "vault kv get -field=key secret/xyte"` (Vault), `--key-command "aws secretsmanager get-secret-value --secret-id xyte --query SecretString --output text"` (AWS Secrets Manager), or `--key-command "pass show xyte/api-key"` (pass). The command must print only the key on stdout and exit 0; non-zero exits surface as `CliUserError` with the exit code only.
- `xyte-cli setup status --field tenantId` is the primary shell-neutral extractor for follow-up commands.
- If `--provider` is omitted, setup probes `xyte-org` first, then `xyte-partner`.
- `--connectivity never` requires an explicit `--provider`.
- Use `--provider xyte-partner` for partner-only tenants.
- For `xyte-org`, when `--name` is omitted, setup attempts to populate tenant display name from `organization.getOrganizationInfo`.
- Explicit `--name` always takes precedence over auto-detected names.
- Persisted credentials default to `auth.secretStoreBackend=auto`: macOS Keychain, Windows DPAPI, Linux Secret Service.
- If native secure storage is unavailable under `auto`, `xyte-cli` warns and falls back to the file backend.
- Advanced override: `auth.secretStoreBackend=auto|native|file`.
- `xyte-cli config set auth.secretStoreBackend native` requires native secure storage; `xyte-cli config set auth.secretStoreBackend file` uses file storage intentionally.
- `xyte-cli config path` reports `secretStoreBackend`, `secretStore`, and `legacySecretStore`. `secretStore` is the effective location for the selected backend: a filesystem path when `secretStoreBackend` is `file`, and the service name used in the OS keychain (e.g. `xyte-cli`) when it is `keychain`, `dpapi`, or `secret-service`.

## Tenant And Auth Slots

```bash
xyte-cli config tenant add <tenant-id> --name "Acme"
xyte-cli config tenant use <tenant-id>
xyte-cli config tenant list
xyte-cli config tenant remove <tenant-id> --confirm

xyte-cli config key add --tenant <tenant-id> --name primary --key "<value>" --set-active
xyte-cli config key add --tenant <tenant-id> --name primary --key-file ~/.config/xyte/acme.key --set-active
xyte-cli config key add --tenant <tenant-id> --name primary --key-command "op read op://Employee/Xyte/credential" --set-active
xyte-cli config key add --tenant <tenant-id> --provider xyte-org --name primary --key "<value>" --set-active
xyte-cli config key list --tenant <tenant-id> --output json
xyte-cli config key use --tenant <tenant-id> --provider xyte-org --slot primary
xyte-cli config key update --tenant <tenant-id> --provider xyte-org --slot primary --key "<value>"
xyte-cli config key update --tenant <tenant-id> --provider xyte-org --slot primary --key-file ~/.config/xyte/acme.key
xyte-cli config key update --tenant <tenant-id> --provider xyte-org --slot primary --key-command "op read op://Employee/Xyte/credential"
xyte-cli config key rename --tenant <tenant-id> --provider xyte-org --slot primary --name prod-primary
xyte-cli config key test --tenant <tenant-id> --provider xyte-org --slot prod-primary
xyte-cli config key remove --tenant <tenant-id> --provider xyte-org --slot prod-primary --confirm
```

Auth note:
- Inline `--key "<value>"` examples are shell-sensitive. Prefer `--key-file` or `setup run --key-stdin` for automation.
- `config key add` accepts `--provider` when you want a deterministic route; if omitted, it probes `xyte-org` first and then `xyte-partner`.
- `config tenant remove --confirm` removes tenant profile metadata and clears secrets for known key slots.

## Endpoint Operations

```bash
xyte-cli api endpoints list
xyte-cli api endpoints describe organization.devices.getDevices
xyte-cli api call organization.devices.getDevices --tenant <tenant-id>
xyte-cli api call organization.devices.getDevices --tenant <tenant-id> --output-mode envelope --strict-json [--note <text>]
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

## Utility Pipelines, Space Import, And Device Migration

```bash
xyte-cli util list-actions --output text [--mode friendly|generic] [--execution-support space.import-tree|device.move|edge.claim-batch|prepare-only|call-loop-only]

xyte-cli util prepare \
  --action organization.devices.claimDevice \
  --input ./raw-claims.xlsx \
  --output-dir ./prepared [--primary-format csv|jsonl] [--force]

xyte-cli util prepare \
  --action space.import-tree \
  --input ./raw-hierarchy.pdf \
  --output-dir ./prepared

xyte-cli util prepare \
  --action organization.connectors.prepareSetup \
  --input ./raw-connectors.csv \
  --output-dir ./prepared

xyte-cli util prepare \
  --action organization.teamAccess.groups \
  --input ./raw-team.csv \
  --output-dir ./prepared

xyte-cli util prepare \
  --action organization.teamAccess.users \
  --input ./raw-team.csv \
  --output-dir ./prepared

xyte-cli util prepare \
  --action organization.teamAccess.memberships \
  --input ./raw-team.csv \
  --output-dir ./prepared

xyte-cli util import-tree --tenant <tenant-id> --input ./prepared/space-import-tree.csv \
  [--input-format auto|csv|json|jsonl] [--path-field <name>] [--space-type-field <name>] [--config-field <name>] \
  [--apply] [--continue-on-error] [--report <path>]

xyte-cli util match \
  --source ./source-devices.json --target ./target-spaces.json \
  --source-field name --target-field name \
  --out ./device-moves.csv [--tenant <tenant-id>] [--strict-json]

xyte-cli util move-devices --tenant <tenant-id> --input ./device-moves.csv \
  [--input-format auto|csv|json|jsonl] [--apply] [--continue-on-error] [--report <path>]
```

Utility notes:
- dry-run summaries count rows under `totals.planned`; `totals.succeeded` is reserved for applied rows.
- `util prepare` writes a `.notes.md` human review artifact with column glossary, reject taxonomy, canonical JSON shape, and safe next commands.

## Edge Devices

Edge devices sit behind an Xyte Edge proxy. Claim and ping are asynchronous: a start call returns 204, then the CLI polls the matching status endpoint until terminal. Prefer the `xyte-cli edge` command group over raw `api call` — it handles polling, backoff, and resume.

See [`docs/claim-devices.md`](claim-devices.md) for the full native-vs-edge-vs-C2C decision guide before you pick a command.

```bash
xyte-cli edge claim \
  --tenant <tenant-id> \
  --proxy-id <proxy-id> \
  --device-ip <device-ip> \
  --device-model-id <device-model-id> \
  --space-id <space-id> \
  [--display-name <name>] [--skip-connectivity-check] \
  [--poll-interval-ms 5000] [--poll-timeout-ms 600000] \
  [--plan|--apply] [--output json|text]

xyte-cli edge claim-batch \
  --tenant <tenant-id> \
  --input ./prepared/organization-edge-startclaim.csv \
  [--report <path>] [--resume-artifact <path>] \
  [--skip-connectivity-check] \
  [--poll-interval-ms 5000] [--poll-timeout-ms 600000] \
  [--plan|--apply] [--output json|text]

xyte-cli edge claim-status --tenant <tenant-id> --proxy-id <proxy-id> --device-ip <device-ip> [--output json|text]

xyte-cli edge ping \
  --tenant <tenant-id> \
  --proxy-id <proxy-id> \
  --device-ip <device-ip> \
  [--poll-interval-ms 5000] [--poll-timeout-ms 600000] \
  [--plan|--apply] [--output json|text]

xyte-cli edge ping-status --tenant <tenant-id> --proxy-id <proxy-id> --device-ip <device-ip> [--output json|text]
```

Notes:
- `edge claim`, `edge claim-batch`, and `edge ping` are mutating. `--plan` is the safe default; `--apply` only after explicit user approval.
- `edge claim-status` and `edge ping-status` are read-only.
- Poll defaults: 5 s interval, 10 min timeout.
- `edge claim-batch` runs `edge ping` internally before `startClaim` for blank or `skip_connectivity_check=false` rows. Rows with `skip_connectivity_check=true` skip that ping and send `skip_connectivity_check: true`.
- `edge claim-batch --skip-connectivity-check` makes blank rows skip ping and send `skip_connectivity_check: true`; rows that explicitly set `skip_connectivity_check=false` are rejected as conflicts.
- `edge claim-batch` on a half-finished run requires `--resume-artifact <ndjson-artifact>`; it skips rows previously recorded as `succeeded` or `already-claimed` and re-runs all other rows from the prior artifact. The resume artifact records completed row results, not in-flight claim IDs.
- `edge claim-batch` exits with code 1 if any row ends in `failed`, `rejected`, `timeout`, `proxy-offline`, `ping-failed`, or `aborted`; per-row dispositions are written to `--report`.
- `edge ping` remains a standalone diagnostic command; batch does not rely on ping evidence from a separate command.
- Raw endpoints remain available for advanced cases: `organization.edge.startClaim`, `organization.edge.getClaimStatus`, `organization.edge.startPing`, `organization.edge.getPingStatus`.
- Raw route mapping: `startClaim` -> `POST /core/v1/organization/edge/devices/start_claim`, `getClaimStatus` -> `GET /core/v1/organization/edge/devices/get_claim_status`, `startPing` -> `POST /core/v1/organization/edge/devices/start_ping`, `getPingStatus` -> `GET /core/v1/organization/edge/devices/get_ping_status`.

## Insights And Reports

```bash
xyte-cli ops inspect fleet --tenant <tenant-id> --provider-scope auto --output json [--out <path>] [--strict-json]
xyte-cli ops inspect deep-dive --tenant <tenant-id> --provider-scope auto --window 24 --output json [--out <path>] [--strict-json]
xyte-cli ops report generate --tenant <tenant-id> --input <path> --out <path> [--render markdown|pdf] [--include-sensitive] [--strict-json]
```

Provider scope behavior:
- Use global `--output text|json` for stdout selection. Keep `--render` for report/artifact rendering or explicit inspect ASCII/markdown output.
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
xyte-cli ops console --no-motion --debug --debug-log ./debug.log --tenant <tenant-id>
```

Notes:
- `--once` renders a single frame and exits (default headless behavior). `--once` overrides `--follow`.
- `--follow` streams continuous frames with configurable `--interval-ms`.
- `--no-motion` disables TUI animation effects.
- `--debug` / `--debug-log <path>` enable TUI debug logging.

## Action Log Environment Flags

Primary explicit-path workflow:

```bash
xyte-cli --log-actions --log-actions-path ./logs/xyte-cli.actions.ndjson status --tenant <tenant-id>
xyte-cli logs list --path ./logs/xyte-cli.actions.ndjson --limit 200
xyte-cli logs stats --path ./logs/xyte-cli.actions.ndjson
```

Advanced shell-specific environment flags:

`XYTE_CLI_LOGS_ENABLED` enables NDJSON logging.
`XYTE_CLI_LOGS_MIRROR_TO_STDERR` independently controls stderr mirroring.
Set `XYTE_CLI_LOGS_MAX_FILES=1` to keep only the active file (no rotated history).

```bash
XYTE_CLI_LOGS_ENABLED=1
XYTE_CLI_LOGS_PATH=./logs/xyte-cli.actions.ndjson
XYTE_CLI_LOGS_MIRROR_TO_STDERR=1
XYTE_CLI_LOGS_VERBOSE=1
XYTE_CLI_LOGS_MAX_FILE_BYTES=10485760
XYTE_CLI_LOGS_MAX_FILES=5
```

The legacy `XYTE_LOG_ACTIONS_*` names are deprecated aliases — they still work but emit a deprecation warning. Use the `XYTE_CLI_LOGS_*` names above.

Interactive hotkeys on ops screens:

- `a`: action palette
- `f`: structured filter editor
- `[` / `]`: pagination where supported
- `p`: per-page size where supported
