# Agent Ops Flow Recipes (Deterministic)

These recipes mirror `docs/flows/agent-ops.md` for agent routing.

## Shared Safety

1. Endpoint writes execute only after explicit user approval.
2. `xyte-cli util import-tree` is dry-run by default unless `--apply` is provided.
3. Human decision gates are mandatory before any write or apply loop.

## flow.setup-readiness-10m

```bash
xyte-cli status --mode fast --output json
xyte-cli setup status --tenant <tenant-id> --output json
xyte-cli config doctor --tenant <tenant-id> --output json
xyte-cli status --tenant <tenant-id> --mode fast --output json
xyte-cli ops inspect fleet --tenant <tenant-id> --output json > /tmp/xyte-fleet.setup.json
```

## flow.incidents-delta-watch

```bash
xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --strict-json
xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --interval-ms 2000 --max-polls 30 --strict-json > /tmp/xyte-watch.incidents.ndjson
```

Fallback query:

```bash
NOW=$(date +%s)
xyte-cli api call organization.incidents.getIncidents --tenant <tenant-id> --query-json "{\"status\":\"active\",\"from\":0,\"to\":$NOW,\"page\":1,\"per_page\":100}"
```

## flow.watch-to-triage

```bash
xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --strict-json > /tmp/xyte-watch.triage.ndjson
xyte-cli ops inspect fleet --tenant <tenant-id> --output json > /tmp/xyte-fleet.triage.json
xyte-cli ops inspect deep-dive --tenant <tenant-id> --window 24 --output json > /tmp/xyte-deep-dive.triage.json
xyte-cli ops report generate --tenant <tenant-id> --input /tmp/xyte-deep-dive.triage.json --out /tmp/xyte-triage.md --render markdown
```

## flow.guided-remediation

Write safety requirements:

1. Endpoint writes execute only after an explicit human decision.
2. `xyte-cli util import-tree` is dry-run by default unless `--apply` is provided.
3. Human decision gates are mandatory before any write or apply loop.

```bash
xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --strict-json > /tmp/xyte-watch.before.ndjson

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

xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --strict-json > /tmp/xyte-watch.after.ndjson
```

## flow.daily-deep-dive-report

```bash
xyte-cli setup status --tenant <tenant-id> --output json
xyte-cli ops inspect deep-dive --tenant <tenant-id> --window 24 --output json > /tmp/xyte-deep-dive.daily.json
xyte-cli ops report generate --tenant <tenant-id> --input /tmp/xyte-deep-dive.daily.json --out /tmp/xyte-daily.md --render markdown
xyte-cli ops inspect fleet --tenant <tenant-id> --output json > /tmp/xyte-fleet.daily.json
```
