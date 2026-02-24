# Endpoint Usage Reference (CLI + Headless Agents)

Use this file for deterministic endpoint operations with `xyte-cli call`.

## Discovery Sequence

1. List available endpoint keys:
```bash
xyte-cli list-endpoints
```

2. Inspect one endpoint contract before calling:
```bash
xyte-cli describe-endpoint <endpoint-key>
```

3. Call with explicit tenant and structured params:
```bash
xyte-cli call <endpoint-key> \
  --tenant <tenant-id> \
  --output-mode envelope \
  --path-json '{"id":"..."}' \
  --query-json '{"page":1}' \
  --body-json '{"field":"value"}'
```

## Guard Requirements by Method

| Method | Guard Requirement |
| --- | --- |
| `GET`, `HEAD`, `OPTIONS` | No write guard required |
| `POST`, `PUT`, `PATCH` | Must include `--allow-write` |
| `DELETE` | Must include `--allow-write` and `--confirm <endpoint-key>` |

## Filters and Pagination Matrix (from spec)

Derived from the bundled public endpoint spec.

| Endpoint Key | Query Fields | Pagination Fields | Notes |
| --- | --- | --- | --- |
| `organization.spaces.getSpaces` | `id`, `name`, `parent_id`, `space_type`, `created_before`, `created_after`, `path_includes` | none | Main listing endpoint with server-side filtering |
| `organization.devices.getDevices` | `space_id` | none | Filter devices by one space |
| `organization.devices.getHistories` | `status`, `from`, `to`, `device_id`, `space_id`, `name` | none | Filtered history lookup; can be time-windowed |
| `organization.commands.getCommands` | `status`, `page`, `per_page` | `page`, `per_page` | Command history pagination and status filter |
| `organization.incidents.getIncidents` | `from`, `to`, `status`, `priority`, `title`, `description`, `issue`, `device_model`, `partner_name`, `sub_model`, `space_id`, `page`, `per_page` | `page`, `per_page` | Incident filtering matrix. `from`/`to` are Unix integer timestamps when used. |

All other current endpoint specs in this repo have no declared query params.

## Concrete Filter/Pagination Examples

### `organization.spaces.getSpaces`

```bash
xyte-cli call organization.spaces.getSpaces \
  --tenant <tenant-id> \
  --query-json '{
    "parent_id": "<space-id>",
    "name": "room",
    "space_type": "room"
  }'
```

### `organization.devices.getHistories`

```bash
xyte-cli call organization.devices.getHistories \
  --tenant <tenant-id> \
  --query-json '{
    "status": "online",
    "from": 0,
    "to": 2000000000,
    "space_id": "<space-id>"
  }'
```

## Concrete Write/Delete Examples

### `organization.devices.updateDevice` (write, guarded)

```bash
xyte-cli call organization.devices.updateDevice \
  --tenant <tenant-id> \
  --allow-write \
  --path-json '{"device_id":"<device-id>"}' \
  --body-json '{"name":"New name"}'
```

### `organization.incidents.closeIncident` (destructive, guarded)

```bash
xyte-cli call organization.incidents.closeIncident \
  --tenant <tenant-id> \
  --allow-write \
  --confirm organization.incidents.closeIncident \
  --path-json '{"incident_id":"<incident-id>"}'
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

## Utility Prepare + Space Import

```bash
# discover preprocess actions
xyte-cli utility list-actions --format text

# scaffold canonical files for one action
xyte-cli utility prepare --action organization.devices.claimDevice --input ./raw-source.xlsx --output-dir ./tmp

# scaffold and execute the dedicated import-tree utility
xyte-cli utility prepare --action space.import-tree --input ./raw-tree.pdf --output-dir ./tmp
xyte-cli space import-tree --tenant <tenant-id> --input ./tmp/space-import-tree.csv
xyte-cli space import-tree --tenant <tenant-id> --input ./tmp/space-import-tree.csv --apply --report ./space-import.ndjson
```

Supported prepare output formats:
1. CSV (default)
2. JSONL (optional override)

Prepare output contract:
1. stdout summary: `xyte.utility.prepare.v1`
2. scaffold files: primary + rejected + notes
3. MCP parity: `xyte_utility_prepare`, `xyte_utility_list_actions`, `xyte_space_import_tree`

## Multi-tenant Determinism

- Always pass `--tenant <tenant-id>` for automation.
- Prefer `--output-mode envelope` for machine loops to capture request/guard/retry metadata.
- Use `xyte-cli tenant use <tenant-id>` only for interactive/default context.
- Keep auth explicit with named slots:
  - `xyte-cli auth key list --tenant <tenant-id> --format json`
  - `xyte-cli auth key use --tenant <tenant-id> --provider <provider> --slot <id|name>`

## Notes

- Keep endpoint exploration and invocation on `xyte-cli` commands.
- Do not rely on repo-local script paths for agent operation.
