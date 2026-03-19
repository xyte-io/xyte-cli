# Endpoint Usage Reference (CLI + Headless Agents)

Use this file for deterministic endpoint operations with `xyte-cli api call`.

## Discovery Sequence

1. List available endpoint keys:

```bash
xyte-cli api endpoints list
```

2. Inspect one endpoint contract before calling:

```bash
xyte-cli api endpoints describe <endpoint-key>
```

3. Call with explicit tenant and structured params:

```bash
xyte-cli api call <endpoint-key> \
  --tenant <tenant-id> \
  --output-mode envelope \
  --path-json '{"id":"..."}' \
  --query-json '{"page":1}' \
  --body-json '{"field":"value"}'
```

## Method Behavior

| Method | Operator expectation |
| --- | --- |
| `GET`, `HEAD`, `OPTIONS` | Read-only request |
| `POST`, `PUT`, `PATCH` | Execute only after explicit user approval |
| `DELETE` | Execute only after explicit user approval |

## Filters And Pagination Matrix (From Spec)

Derived from the bundled public endpoint spec.

| Endpoint Key | Query Fields | Pagination Fields | Notes |
| --- | --- | --- | --- |
| `organization.spaces.getSpaces` | `id`, `name`, `parent_id`, `space_type`, `created_before`, `created_after`, `path_includes` | none | Main listing endpoint with server-side filtering |
| `organization.devices.getDevices` | `space_id` | none | Filter devices by one space |
| `organization.devices.getHistories` | `status`, `from`, `to`, `device_id`, `space_id`, `name` | none | Filtered history lookup; can be time-windowed |
| `organization.commands.getCommands` | `status`, `page`, `per_page` | `page`, `per_page` | Command history pagination and status filter |
| `organization.incidents.getIncidents` | `from`, `to`, `status`, `priority`, `title`, `description`, `issue`, `device_model`, `partner_name`, `sub_model`, `space_id`, `page`, `per_page` | `page`, `per_page` | Incident filtering matrix. Use integer `from` and `to`; for reliable active-incident fetches use both (`from=0`, `to=<now>`). |

All other current endpoint specs in this repo have no declared query params.

## Concrete Filter/Pagination Examples

### `organization.spaces.getSpaces`

```bash
xyte-cli api call organization.spaces.getSpaces \
  --tenant <tenant-id> \
  --query-json '{
    "parent_id": "<space-id>",
    "name": "room",
    "space_type": "room"
  }'
```

### `organization.devices.getHistories`

```bash
xyte-cli api call organization.devices.getHistories \
  --tenant <tenant-id> \
  --query-json '{
    "status": "online",
    "from": 0,
    "to": 2000000000,
    "space_id": "<space-id>"
  }'
```

### `organization.incidents.getIncidents`

```bash
xyte-cli api call organization.incidents.getIncidents \
  --tenant <tenant-id> \
  --query-json '{"status":"active","from":0,"to":1710000000,"page":1,"per_page":100}'
```

Replace `1710000000` with the current Unix timestamp in your shell or runtime. Use explicit integer Unix timestamps for `from` and `to`. In some environments, omitted or `null` bounds can return empty results.

## Concrete Write/Delete Examples

### `organization.incidents.closeIncident`

```bash
xyte-cli api call organization.incidents.closeIncident \
  --tenant <tenant-id> \
  --path-json '{"incident_id":"<incident-id>"}'
```

### `organization.commands.sendCommand`

```bash
xyte-cli api call organization.commands.sendCommand \
  --tenant <tenant-id> \
  --path-json '{"device_id":"<device-id>"}' \
  --body-json '{"command":"reboot"}'
```

## Common Endpoint Keys

Organization:
- `organization.devices.getDevices`
- `organization.devices.getDevice`
- `organization.incidents.closeIncident`
- `organization.incidents.getIncidents`
- `organization.tickets.getTickets`
- `organization.commands.sendCommand`

Partner:
- `partner.devices.getDevices`
- `partner.devices.getDeviceInfo`
- `partner.tickets.getTickets`

## Util Prepare + Import Tree

```bash
# discover preprocess actions
xyte-cli util list-actions --output text

# scaffold canonical files for one action
xyte-cli util prepare --action organization.devices.claimDevice --input ./raw-source.xlsx --output-dir ./prepared

# scaffold and execute the dedicated import-tree utility
xyte-cli util prepare --action space.import-tree --input ./raw-tree.pdf --output-dir ./prepared
xyte-cli util import-tree --tenant <tenant-id> --input ./prepared/space-import-tree.csv
xyte-cli util import-tree --tenant <tenant-id> --input ./prepared/space-import-tree.csv --apply --report ./artifacts/space-import.ndjson
```

Supported prepare output formats:
1. CSV (default)
2. JSONL (optional override)

Prepare output contract:
1. stdout summary: `xyte.utility.prepare.v1`
2. scaffold files: primary + rejected + notes

## Multi-Tenant Determinism

- Always pass `--tenant <tenant-id>` for automation.
- Prefer `--output-mode envelope` for machine loops to capture request/guard/retry metadata.
- Use `xyte-cli config tenant use <tenant-id>` only for interactive/default context.
- Keep auth explicit with named slots:
  - `xyte-cli config key list --tenant <tenant-id> --output json`
  - `xyte-cli config key use --tenant <tenant-id> --provider <provider> --slot <id|name>`

## Notes

- Keep endpoint exploration and invocation on `xyte-cli` commands.
- Do not rely on repo-local script paths for agent operation.
- Examples that pass `--path-json`, `--query-json`, or `--body-json` use inline JSON strings. If the host shell has different quoting rules, construct the JSON string in that shell or runtime before calling `xyte-cli`.
