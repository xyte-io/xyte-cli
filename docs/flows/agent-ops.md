# AI Agent Ops Flow Pack V1

Deterministic operator flows for AI-agent usage on top of existing `xyte-cli` commands.

Primary setup, watch, inspect, and report commands below use the cross-platform CLI contract. Advanced raw API examples that embed JSON remain shell-specific because quoting still differs across PowerShell, CMD, Bash, and zsh.

## Shared Safety Rules

1. Non-read endpoint calls execute directly once the operator chooses the write step.
2. Destructive deletes execute directly; no extra confirm flag is required.
3. `xyte-cli util import-tree` is dry-run by default unless `--apply` is provided.
4. Human decision gate is mandatory before any write/apply loop.

## Executable Flows

These recipes are first-class executable flows:

```bash
xyte-cli flow list
xyte-cli flow run <flow-id> --tenant <tenant-id> --plan
xyte-cli flow run <flow-id> --tenant <tenant-id> --apply --resume <run-id-or-path>
```

Runner behavior:
- default mode is `--plan` (safe dry mode).
- `--apply` advances one explicit human gate per invocation.
- missing context still produces structured stop states (`pending_gate` or `needs_input`), not silent skips.
- artifacts are persisted under `./tmp/flow-runs/<flow-id>/<timestamp>-<run-id>/`:
  - `manifest.json`, `inputs.json`
  - `decisions.ndjson`, `errors.ndjson`, `watch-frames.ndjson`
  - per-step artifacts in `steps/` and generated outputs in `outputs/`
- for create/edit/share/import custom aliases, see `custom-workflows.md`.

## flow.setup-readiness-10m

- Flow ID: `flow.setup-readiness-10m`
- Intent: verify install, tenant readiness, connectivity, and basic fleet visibility in under 10 minutes.
- Prerequisites:
  - `xyte-cli` is installed.
  - `<tenant-id>` is known.
- Exact commands:

```bash
xyte-cli setup status --tenant <tenant-id> --output json
xyte-cli config doctor --tenant <tenant-id> --output json
xyte-cli status --tenant <tenant-id> --mode fast --output json
xyte-cli ops inspect fleet --tenant <tenant-id> --output json --out ./artifacts/xyte-fleet.setup.json
```

- Expected artifacts:
  - readiness JSON from setup status.
  - connectivity diagnostics JSON from config doctor.
  - fleet snapshot JSON at `./artifacts/xyte-fleet.setup.json`.
- Stop/decision gates:
  - Stop if setup status is not ready.
  - Stop if config doctor reports failed connectivity.
  - Continue to incident monitoring only after readiness is healthy.
- Failure fallback:
  - Run `xyte-cli setup run --tenant <tenant-id>` if key provisioning is missing.
  - If setup must stay offline, use `xyte-cli setup run --tenant <tenant-id> --provider <xyte-org|xyte-partner> --connectivity never`.
  - Re-run this flow after setup.

## flow.incidents-delta-watch

- Flow ID: `flow.incidents-delta-watch`
- Intent: stream deterministic incident deltas. Use terminal text for operators and `--output json --strict-json` for `xyte.watch.frame.v1` frames.
- Prerequisites:
  - `flow.setup-readiness-10m` completed.
  - `<tenant-id>` is active and authorized.
- Exact commands:

```bash
xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --output json --strict-json
xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --interval-ms 2000 --max-polls 30 --output json --strict-json --out ./artifacts/xyte-watch.incidents.ndjson
```

- Expected artifacts:
  - first snapshot frame from `--once`.
  - continuous watch frames at `./artifacts/xyte-watch.incidents.ndjson` with `snapshot|delta|heartbeat|error` events.
- Stop/decision gates:
  - Stop and open triage if any `delta` frame contains added/updated incidents.
  - Stop if repeated `error` frames occur.
- Failure fallback:
  - Run `xyte-cli api endpoints describe organization.incidents.getIncidents`.
  - Re-run `organization.incidents.getIncidents` with explicit integer `from`, `to`, `page`, and `per_page` values using native shell syntax for your environment.

## flow.watch-to-triage

- Flow ID: `flow.watch-to-triage`
- Intent: pivot from watch deltas into deterministic triage artifacts.
- Prerequisites:
  - at least one active incident from watch output.
  - `<tenant-id>` is active and authorized.
- Exact commands:

```bash
xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --output json --strict-json --out ./artifacts/xyte-watch.triage.ndjson
xyte-cli ops inspect fleet --tenant <tenant-id> --output json --out ./artifacts/xyte-fleet.triage.json
xyte-cli ops inspect deep-dive --tenant <tenant-id> --window 24 --output json --out ./artifacts/xyte-deep-dive.triage.json
xyte-cli ops report generate --tenant <tenant-id> --input ./artifacts/xyte-deep-dive.triage.json --out ./reports/xyte-triage.md --render markdown
```

- Expected artifacts:
  - watch snapshot for triage at `./artifacts/xyte-watch.triage.ndjson`.
  - fleet context at `./artifacts/xyte-fleet.triage.json`.
  - deep-dive JSON at `./artifacts/xyte-deep-dive.triage.json`.
  - triage markdown report at `./reports/xyte-triage.md`.
- Stop/decision gates:
  - Human decision gate: choose read-only monitoring or switch to `flow.guided-remediation`.
  - Stop if deep-dive/report generation fails validation.
- Failure fallback:
  - Re-run watch once and deep-dive with `--window 6`.
  - If failures persist, return to `flow.setup-readiness-10m`.

## flow.guided-remediation

- Flow ID: `flow.guided-remediation`
- Intent: run controlled org-scope command/ticket/incident remediation with explicit human gates.
- Prerequisites:
  - triage artifacts exist and identify concrete `<device-id>`, `<ticket-id>`, and `<incident-id>`.
  - human operator approval to execute writes.
- Shell note:
  - the raw `api call ... --path-json/--body-json` examples below are Bash/zsh-shaped because inline JSON quoting still differs by shell.
  - on PowerShell or CMD, prefer `xyte-cli flow run flow.guided-remediation --tenant <tenant-id> --plan` and adapt any copied write commands to your shell.
- Exact commands:

```bash
xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --output json --strict-json --out ./artifacts/xyte-watch.before.ndjson

xyte-cli api call organization.commands.getCommands \
  --tenant <tenant-id> \
  --path-json '{"device_id":"<device-id>"}' \
  --query-json '{"page":1,"per_page":20}'

xyte-cli api call organization.commands.sendCommand \
  --tenant <tenant-id> \
  --path-json '{"device_id":"<device-id>"}' \
  --body-json '{"command":"<valid-command-from-history>"}'

xyte-cli api call organization.devices.updateDevice \
  --tenant <tenant-id> \
  --path-json '{"device_id":"<device-id>"}' \
  --body-json '{"name":"<updated-device-name>"}'

xyte-cli api call organization.devices.getDevice \
  --tenant <tenant-id> \
  --path-json '{"device_id":"<device-id>"}'

xyte-cli api call organization.tickets.sendMessage \
  --tenant <tenant-id> \
  --path-json '{"ticket_id":"<ticket-id>"}' \
  --query-json '{"message":"Operator approved remediation for incident <incident-id> on device <device-id>."}'

xyte-cli api call organization.incidents.closeIncident \
  --tenant <tenant-id> \
  --path-json '{"incident_id":"<incident-id>"}'

xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --output json --strict-json --out ./artifacts/xyte-watch.after.ndjson
```

- Expected artifacts:
  - pre/post watch snapshots for remediation verification.
  - command preflight history and command dispatch response.
  - update-device response plus read-back verification from `organization.devices.getDevice`.
  - ticket message response, incident close response.
- Stop/decision gates:
  - Mandatory human decision gate before each write command or write loop.
  - Stop if command preflight has no valid command/friendly_name for the target device.
  - Stop if update-device read-back does not reflect the expected field changes.
  - Stop immediately on any non-2xx write response.
  - Stop if post-remediation watch still shows unchanged high-priority incidents.
- Failure fallback:
  - Re-run endpoint contract checks and correct payload shape:
    - `xyte-cli api endpoints describe organization.commands.sendCommand`
    - `xyte-cli api endpoints describe organization.tickets.sendMessage`
    - `xyte-cli api endpoints describe organization.incidents.closeIncident`
  - Return to `flow.watch-to-triage` to re-evaluate incident state.
- Write safety requirements:
  - Non-read endpoint calls execute directly once the operator clears the human gate.
  - Destructive deletes execute directly once the operator clears the human gate.
  - `xyte-cli util import-tree` is dry-run by default unless `--apply` is provided.
  - Human decision gate is mandatory before any write/apply loop.
  - Re-run dry-run import before any `--apply`.
- Write safety requirements:
  - Non-read endpoint calls execute directly once the operator clears the human gate.
  - Destructive deletes execute directly once the operator clears the human gate.
  - `xyte-cli util import-tree` is dry-run by default unless `--apply` is provided.
  - Human decision gate is mandatory before any write/apply loop.

## flow.daily-deep-dive-report

- Flow ID: `flow.daily-deep-dive-report`
- Intent: produce daily deep-dive JSON and markdown report artifacts for operator review.
- Prerequisites:
  - `flow.setup-readiness-10m` completed.
  - `<tenant-id>` is active and authorized.
- Exact commands:

```bash
xyte-cli setup status --tenant <tenant-id> --output json
xyte-cli ops inspect deep-dive --tenant <tenant-id> --window 24 --output json --out ./artifacts/xyte-deep-dive.daily.json
xyte-cli ops report generate --tenant <tenant-id> --input ./artifacts/xyte-deep-dive.daily.json --out ./reports/xyte-daily.md --render markdown
xyte-cli ops inspect fleet --tenant <tenant-id> --output json --out ./artifacts/xyte-fleet.daily.json
```

- Expected artifacts:
  - deep-dive JSON at `./artifacts/xyte-deep-dive.daily.json` (`xyte.inspect.deep-dive.v1`).
  - markdown report at `./reports/xyte-daily.md`.
  - fleet summary JSON at `./artifacts/xyte-fleet.daily.json`.
- Stop/decision gates:
  - Stop if setup status is not ready.
  - Human decision gate: approve report distribution or escalate to `flow.watch-to-triage`.
- Failure fallback:
  - Re-run with a shorter analysis window (`--window 12`).
  - If still failing, return to `flow.setup-readiness-10m`.
