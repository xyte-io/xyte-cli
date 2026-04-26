# Agent Ops Flow Recipes (Deterministic)

These recipes mirror `docs/flows/agent-ops.md` for agent routing.

## Shared Safety

1. Endpoint writes execute only after explicit user approval.
2. `xyte-cli util import-tree` and `xyte-cli util move-devices` are dry-run by default unless `--apply` is provided.
3. Human decision gates are mandatory before any write or apply loop.
4. When a flow stops at a gate, continue with `xyte-cli flow run <flow-id> --tenant <tenant-id> --apply --resume <run-id-or-path>`.

## flow.setup-readiness-10m

```bash
xyte-cli setup status --tenant <tenant-id> --output json
xyte-cli config doctor --tenant <tenant-id> --output json
xyte-cli status --tenant <tenant-id> --mode fast --output json
xyte-cli ops inspect fleet --tenant <tenant-id> --output json --out ./artifacts/xyte-fleet.setup.json
```

## flow.incidents-delta-watch

```bash
xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --output json --strict-json
xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --interval-ms 2000 --max-polls 30 --output json --strict-json --out ./artifacts/xyte-watch.incidents.ndjson
```

Fallback query (replace `1710000000` with the current Unix timestamp in your shell or runtime):

```bash
xyte-cli api call organization.incidents.getIncidents \
  --tenant <tenant-id> \
  --query-json '{"status":"active","from":0,"to":1710000000,"page":1,"per_page":100}'
```

## flow.watch-to-triage

```bash
xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --output json --strict-json --out ./artifacts/xyte-watch.triage.ndjson
xyte-cli ops inspect fleet --tenant <tenant-id> --output json --out ./artifacts/xyte-fleet.triage.json
xyte-cli ops inspect deep-dive --tenant <tenant-id> --window 24 --output json --out ./artifacts/xyte-deep-dive.triage.json
xyte-cli ops report generate --tenant <tenant-id> --input ./artifacts/xyte-deep-dive.triage.json --out ./reports/xyte-triage.md --render markdown
```

## flow.guided-remediation

Write safety requirements:

1. Endpoint writes execute only after an explicit human decision.
2. `xyte-cli util import-tree` is dry-run by default unless `--apply` is provided.
3. Human decision gates are mandatory before any write or apply loop.
4. The raw `api call ... --path-json/--body-json` examples below are Bash/zsh-shaped because inline JSON quoting still differs by shell. On PowerShell or CMD, prefer `xyte-cli flow run flow.guided-remediation --tenant <tenant-id> --plan` and adapt copied write commands to your shell.

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

## flow.device-migration

```bash
mkdir -p ./artifacts ./reports
xyte-cli api call organization.devices.getDevices --tenant <tenant-id> --query space_id=<source-space-id> --output json > ./artifacts/source-devices.json
xyte-cli api call organization.spaces.getSpaces --tenant <tenant-id> --query path_includes=<target-path> --output json > ./artifacts/target-spaces.json
xyte-cli util match --tenant <tenant-id> --source ./artifacts/source-devices.json --target ./artifacts/target-spaces.json --source-field name --target-field name --out ./artifacts/device-moves.csv
xyte-cli ops report generate --tenant <tenant-id> --input ./artifacts/device-moves.csv.summary.json --out ./reports/device-migration-pre.md --render markdown
xyte-cli util move-devices --tenant <tenant-id> --input ./artifacts/device-moves.csv --report ./artifacts/device-migration.dry-run.ndjson
xyte-cli util move-devices --tenant <tenant-id> --input ./artifacts/device-moves.csv --apply --report ./artifacts/device-migration.apply.ndjson > ./artifacts/device-migration.apply.json
xyte-cli ops inspect fleet --tenant <tenant-id> --output json --out ./artifacts/xyte-fleet.device-migration.json
```

When run through `xyte-cli flow run flow.device-migration`, the flow runner also executes two additional verification steps not in the manual recipe:
- **verify_moved_devices** (`device.verify-batch`): re-fetches each moved device and confirms its `space_id` matches the target from the move plan.
- **post_migration_report** (`report.generate`): composes a post-migration markdown report from the execution, verification, and fleet artifacts.

## flow.edge-claim

Claim one edge device end-to-end. `startClaim` is mutating; default to `--plan` and require explicit approval before `--apply`. See `references/claim-playbook.md` for disambiguation vs native/direct claim.

```bash
xyte-cli edge claim --tenant <tenant-id> --proxy-id <proxy-id> --device-ip <device-ip> --device-model-id <model-id> --space-id <space-id> --plan
xyte-cli edge claim --tenant <tenant-id> --proxy-id <proxy-id> --device-ip <device-ip> --device-model-id <model-id> --space-id <space-id> --apply
```

Failure path (happens-once example): `startClaim` returns 422 (unknown device model id) → disposition `rejected`, no poll; fix model id and re-run.

## flow.edge-claim-batch

North-star bulk-claim flow: `util prepare` → dry-run → gate → apply. Writes a per-row audit NDJSON report and a separate resume artifact. Blank or `skip_connectivity_check=false` rows run a pre-claim ping inside the batch before `startClaim`.

```bash
xyte-cli util prepare --action organization.edge.startClaim --tenant <tenant-id> --input ./devices.xlsx --output-dir ./prepared
xyte-cli edge claim-batch --tenant <tenant-id> --input ./prepared/organization-edge-startclaim.csv --plan
xyte-cli edge claim-batch --tenant <tenant-id> --input ./prepared/organization-edge-startclaim.csv --apply --report ./artifacts/edge-claim.report.ndjson --resume-artifact ./artifacts/edge-claim.resume.ndjson
```

Resume after interruption: re-run the `--apply` line with the same `--resume-artifact` path. Never re-run a half-finished batch without it.

Failure path: 2-of-3 rows succeed, 1 row rejected or `ping-failed` → exit 1 with a per-row NDJSON report (`--report`); fix the row or connectivity and re-run with `--resume-artifact`.

## flow.edge-ping

```bash
xyte-cli edge ping --tenant <tenant-id> --proxy-id <proxy-id> --device-ip <device-ip> --plan
xyte-cli edge ping --tenant <tenant-id> --proxy-id <proxy-id> --device-ip <device-ip> --apply
```

Failure path: status stays `pending` past timeout → disposition `timeout`; re-run after fixing connectivity upstream.

## flow.daily-deep-dive-report

```bash
xyte-cli setup status --tenant <tenant-id> --output json
xyte-cli ops inspect deep-dive --tenant <tenant-id> --window 24 --output json --out ./artifacts/xyte-deep-dive.daily.json
xyte-cli ops report generate --tenant <tenant-id> --input ./artifacts/xyte-deep-dive.daily.json --out ./reports/xyte-daily.md --render markdown
xyte-cli ops inspect fleet --tenant <tenant-id> --output json --out ./artifacts/xyte-fleet.daily.json
```
