# Agent Ops Flow Recipes (Deterministic)

These recipes mirror `docs/flows/agent-ops.md` for agent routing.

## Shared Safety

1. Non-read endpoint calls require `--allow-write`.
2. Destructive deletes require `--allow-write --confirm <endpoint-key>`.
3. `xyte-cli space import-tree` is dry-run by default unless `--apply` is provided.
4. Human decision gate is mandatory before any write/apply loop.

## flow.setup-readiness-10m

```bash
xyte-cli doctor install --format json
xyte-cli setup status --tenant <tenant-id> --format json
xyte-cli config doctor --tenant <tenant-id> --format json
xyte-cli status --tenant <tenant-id> --mode fast --format json
xyte-cli inspect fleet --tenant <tenant-id> --format json > /tmp/xyte-fleet.setup.json
```

## flow.incidents-delta-watch

```bash
xyte-cli watch --tenant <tenant-id> --profile incidents-active --once --strict-json
xyte-cli watch --tenant <tenant-id> --profile incidents-active --interval-ms 2000 --max-polls 30 --strict-json > /tmp/xyte-watch.incidents.ndjson
```

Fallback query:

```bash
NOW=$(date +%s)
xyte-cli call organization.incidents.getIncidents --tenant <tenant-id> --query-json "{\"status\":\"active\",\"from\":0,\"to\":$NOW,\"page\":1,\"per_page\":100}"
```

## flow.watch-to-triage

```bash
xyte-cli watch --tenant <tenant-id> --profile incidents-active --once --strict-json > /tmp/xyte-watch.triage.ndjson
xyte-cli inspect fleet --tenant <tenant-id> --format json > /tmp/xyte-fleet.triage.json
xyte-cli inspect deep-dive --tenant <tenant-id> --window 24 --format json > /tmp/xyte-deep-dive.triage.json
xyte-cli report generate --tenant <tenant-id> --input /tmp/xyte-deep-dive.triage.json --out /tmp/xyte-triage.md --format markdown
```

## flow.guided-remediation

Write safety requirements:

1. Non-read endpoint calls require `--allow-write`.
2. Destructive deletes require `--allow-write --confirm <endpoint-key>`.
3. `xyte-cli space import-tree` is dry-run by default unless `--apply` is provided.
4. Human decision gate is mandatory before any write/apply loop.

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

## flow.bulk-claim-and-space-import

Write safety requirements:

1. Non-read endpoint calls require `--allow-write`.
2. Destructive deletes require `--allow-write --confirm <endpoint-key>`.
3. `xyte-cli space import-tree` is dry-run by default unless `--apply` is provided.
4. Human decision gate is mandatory before any write/apply loop.

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

## flow.daily-deep-dive-report

```bash
xyte-cli setup status --tenant <tenant-id> --format json
xyte-cli inspect deep-dive --tenant <tenant-id> --window 24 --format json > /tmp/xyte-deep-dive.daily.json
xyte-cli report generate --tenant <tenant-id> --input /tmp/xyte-deep-dive.daily.json --out /tmp/xyte-daily.md --format markdown
xyte-cli inspect fleet --tenant <tenant-id> --format json > /tmp/xyte-fleet.daily.json
```
