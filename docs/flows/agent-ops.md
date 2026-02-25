# AI Agent Ops Flow Pack V1

Deterministic operator flows for AI-agent usage on top of existing `xyte-cli` commands.

## Shared Safety Rules

1. Non-read endpoint calls require `--allow-write`.
2. Destructive deletes require `--allow-write --confirm <endpoint-key>`.
3. `xyte-cli space import-tree` is dry-run by default unless `--apply` is provided.
4. Human decision gate is mandatory before any write/apply loop.

## flow.setup-readiness-10m

- Flow ID: `flow.setup-readiness-10m`
- Intent: verify install, tenant readiness, connectivity, and basic fleet visibility in under 10 minutes.
- Prerequisites:
  - `xyte-cli` is installed.
  - `<tenant-id>` is known.
- Exact commands:

```bash
xyte-cli doctor install --format json
xyte-cli setup status --tenant <tenant-id> --format json
xyte-cli config doctor --tenant <tenant-id> --format json
xyte-cli status --tenant <tenant-id> --mode fast --format json
xyte-cli inspect fleet --tenant <tenant-id> --format json > /tmp/xyte-fleet.setup.json
```

- Expected artifacts:
  - readiness JSON from setup status.
  - connectivity diagnostics JSON from config doctor.
  - fleet snapshot JSON at `/tmp/xyte-fleet.setup.json`.
- Stop/decision gates:
  - Stop if setup status is not ready.
  - Stop if config doctor reports failed connectivity.
  - Continue to incident monitoring only after readiness is healthy.
- Failure fallback:
  - Run `xyte-cli setup run --tenant <tenant-id>` if key provisioning is missing.
  - Re-run this flow after setup.

## flow.incidents-delta-watch

- Flow ID: `flow.incidents-delta-watch`
- Intent: stream deterministic incident deltas as `xyte.watch.frame.v1` NDJSON frames.
- Prerequisites:
  - `flow.setup-readiness-10m` completed.
  - `<tenant-id>` is active and authorized.
- Exact commands:

```bash
xyte-cli watch --tenant <tenant-id> --profile incidents-active --once --strict-json
xyte-cli watch --tenant <tenant-id> --profile incidents-active --interval-ms 2000 --max-polls 30 --strict-json > /tmp/xyte-watch.incidents.ndjson
```

- Expected artifacts:
  - first snapshot frame from `--once`.
  - continuous watch frames at `/tmp/xyte-watch.incidents.ndjson` with `snapshot|delta|heartbeat|error` events.
- Stop/decision gates:
  - Stop and open triage if any `delta` frame contains added/updated incidents.
  - Stop if repeated `error` frames occur.
- Failure fallback:
  - Run a bounded read call:

```bash
NOW=$(date +%s)
xyte-cli call organization.incidents.getIncidents --tenant <tenant-id> --query-json "{\"status\":\"active\",\"from\":0,\"to\":$NOW,\"page\":1,\"per_page\":100}"
```

## flow.watch-to-triage

- Flow ID: `flow.watch-to-triage`
- Intent: pivot from watch deltas into deterministic triage artifacts.
- Prerequisites:
  - at least one active incident from watch output.
  - `<tenant-id>` is active and authorized.
- Exact commands:

```bash
xyte-cli watch --tenant <tenant-id> --profile incidents-active --once --strict-json > /tmp/xyte-watch.triage.ndjson
xyte-cli inspect fleet --tenant <tenant-id> --format json > /tmp/xyte-fleet.triage.json
xyte-cli inspect deep-dive --tenant <tenant-id> --window 24 --format json > /tmp/xyte-deep-dive.triage.json
xyte-cli report generate --tenant <tenant-id> --input /tmp/xyte-deep-dive.triage.json --out /tmp/xyte-triage.md --format markdown
```

- Expected artifacts:
  - watch snapshot for triage at `/tmp/xyte-watch.triage.ndjson`.
  - fleet context at `/tmp/xyte-fleet.triage.json`.
  - deep-dive JSON at `/tmp/xyte-deep-dive.triage.json`.
  - triage markdown report at `/tmp/xyte-triage.md`.
- Stop/decision gates:
  - Human decision gate: choose read-only monitoring or switch to `flow.guided-remediation`.
  - Stop if deep-dive/report generation fails validation.
- Failure fallback:
  - Re-run watch once and deep-dive with `--window 6`.
  - If failures persist, return to `flow.setup-readiness-10m`.

## flow.guided-remediation

- Flow ID: `flow.guided-remediation`
- Intent: run controlled org-scope command/ticket/incident remediation with explicit write guards.
- Prerequisites:
  - triage artifacts exist and identify concrete `<device-id>`, `<ticket-id>`, and `<incident-id>`.
  - human operator approval to execute writes.
- Exact commands:

```bash
xyte-cli watch --tenant <tenant-id> --profile incidents-active --once --strict-json > /tmp/xyte-watch.before.ndjson

xyte-cli call organization.commands.getCommands \
  --tenant <tenant-id> \
  --path-json '{"device_id":"<device-id>"}' \
  --query-json '{"page":1,"per_page":20}'

xyte-cli call organization.commands.sendCommand \
  --tenant <tenant-id> \
  --allow-write \
  --path-json '{"device_id":"<device-id>"}' \
  --body-json '{"command":"<valid-command-from-history>"}'

xyte-cli call organization.devices.updateDevice \
  --tenant <tenant-id> \
  --allow-write \
  --path-json '{"device_id":"<device-id>"}' \
  --body-json '{"name":"<updated-device-name>"}'

xyte-cli call organization.devices.getDevice \
  --tenant <tenant-id> \
  --path-json '{"device_id":"<device-id>"}'

xyte-cli call organization.tickets.sendMessage \
  --tenant <tenant-id> \
  --allow-write \
  --path-json '{"ticket_id":"<ticket-id>"}' \
  --query-json '{"message":"Operator approved remediation for incident <incident-id> on device <device-id>."}'

xyte-cli call organization.incidents.closeIncident \
  --tenant <tenant-id> \
  --allow-write \
  --confirm organization.incidents.closeIncident \
  --path-json '{"incident_id":"<incident-id>"}'

xyte-cli watch --tenant <tenant-id> --profile incidents-active --once --strict-json > /tmp/xyte-watch.after.ndjson
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
    - `xyte-cli describe-endpoint organization.commands.sendCommand`
    - `xyte-cli describe-endpoint organization.tickets.sendMessage`
    - `xyte-cli describe-endpoint organization.incidents.closeIncident`
  - Return to `flow.watch-to-triage` to re-evaluate incident state.
- Write safety requirements:
  - Non-read endpoint calls require `--allow-write`.
  - Destructive deletes require `--allow-write --confirm <endpoint-key>`.
  - `xyte-cli space import-tree` is dry-run by default unless `--apply` is provided.
  - Human decision gate is mandatory before any write/apply loop.

## flow.bulk-claim-and-space-import

- Flow ID: `flow.bulk-claim-and-space-import`
- Intent: preprocess bulk claim/import inputs, dry-run safely, then execute guarded apply/write steps.
- Prerequisites:
  - source files exist at `./claims-source.csv` and `./spaces-source.csv`.
  - `<tenant-id>` is active and authorized.
  - human operator approval to execute writes.
- Exact commands:

```bash
xyte-cli utility prepare \
  --action organization.devices.claimDevice \
  --tenant <tenant-id> \
  --input ./claims-source.csv \
  --output-dir ./tmp/flow-bulk-claim

xyte-cli call organization.spaces.getSpace \
  --tenant <tenant-id> \
  --path-json '{"space_id":"<space-id>"}'

xyte-cli utility prepare \
  --action space.import-tree \
  --tenant <tenant-id> \
  --input ./spaces-source.csv \
  --output-dir ./tmp/flow-space-import

xyte-cli space import-tree \
  --tenant <tenant-id> \
  --input ./tmp/flow-space-import/space-import-tree.csv \
  --report ./tmp/flow-space-import/space-import-tree.dryrun.ndjson

xyte-cli call organization.devices.claimDevice \
  --tenant <tenant-id> \
  --allow-write \
  --output-mode envelope \
  --body-json '{"name":"<device-name>","space_id":"<space-id>","sn":"<serial>","mac":"<mac>","cloud_id":"<cloud-id>"}'

xyte-cli space import-tree \
  --tenant <tenant-id> \
  --input ./tmp/flow-space-import/space-import-tree.csv \
  --apply \
  --report ./tmp/flow-space-import/space-import-tree.apply.ndjson
```

- Expected artifacts:
  - claim prep files in `./tmp/flow-bulk-claim`.
  - space import prep files and dry-run/apply NDJSON reports in `./tmp/flow-space-import`.
- Stop/decision gates:
  - Mandatory human decision gate after preprocessing and before claim/apply loops.
  - Stop claim loops when claim probe returns `HTTP 422` with upstream `No device found`.
  - Stop if `organization.spaces.getSpace` fails for target `space_id`.
  - Stop if dry-run report shows invalid rows or unexpected creates/updates.
  - Stop if any claim response fails.
- Failure fallback:
  - Correct rejected rows and re-run `utility prepare`.
  - Re-run dry-run import before any `--apply`.
- Write safety requirements:
  - Non-read endpoint calls require `--allow-write`.
  - Destructive deletes require `--allow-write --confirm <endpoint-key>`.
  - `xyte-cli space import-tree` is dry-run by default unless `--apply` is provided.
  - Human decision gate is mandatory before any write/apply loop.

## flow.daily-deep-dive-report

- Flow ID: `flow.daily-deep-dive-report`
- Intent: produce daily deep-dive JSON and markdown report artifacts for operator review.
- Prerequisites:
  - `flow.setup-readiness-10m` completed.
  - `<tenant-id>` is active and authorized.
- Exact commands:

```bash
xyte-cli setup status --tenant <tenant-id> --format json
xyte-cli inspect deep-dive --tenant <tenant-id> --window 24 --format json > /tmp/xyte-deep-dive.daily.json
xyte-cli report generate --tenant <tenant-id> --input /tmp/xyte-deep-dive.daily.json --out /tmp/xyte-daily.md --format markdown
xyte-cli inspect fleet --tenant <tenant-id> --format json > /tmp/xyte-fleet.daily.json
```

- Expected artifacts:
  - deep-dive JSON at `/tmp/xyte-deep-dive.daily.json` (`xyte.inspect.deep-dive.v1`).
  - markdown report at `/tmp/xyte-daily.md`.
  - fleet summary JSON at `/tmp/xyte-fleet.daily.json`.
- Stop/decision gates:
  - Stop if setup status is not ready.
  - Human decision gate: approve report distribution or escalate to `flow.watch-to-triage`.
- Failure fallback:
  - Re-run with a shorter analysis window (`--window 12`).
  - If still failing, return to `flow.setup-readiness-10m`.
