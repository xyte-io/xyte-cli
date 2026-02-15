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

Source: `/Users/porton/Projects/xyte-cli/src/spec/public-endpoints.json`

| Endpoint Key | Query Fields | Pagination Fields | Notes |
| --- | --- | --- | --- |
| `organization.spaces.getSpaces` | `page`, `per_page`, `id`, `parent_id`, `name`, `path_includes`, `space_type`, `created_before`, `created_after` | `page`, `per_page` | Main listing endpoint with server-side filtering |
| `organization.devices.getHistories` | `status`, `from`, `to`, `device_id`, `space_id`, `name` | none | Filtered history lookup; can be time-windowed |

All other current endpoint specs in this repo have no declared query params.

## Concrete Filter/Pagination Examples

### `organization.spaces.getSpaces`

```bash
xyte-cli call organization.spaces.getSpaces \
  --tenant <tenant-id> \
  --query-json '{
    "page": 1,
    "per_page": 25,
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
    "from": "2026-02-01T00:00:00Z",
    "to": "2026-02-06T23:59:59Z",
    "space_id": "<space-id>"
  }'
```

## Common Endpoint Keys

Organization:
- `organization.devices.getDevices`
- `organization.devices.getDevice`
- `organization.incidents.getIncidents`
- `organization.tickets.getTickets`
- `organization.commands.sendCommand`

Partner:
- `partner.devices.getDevices`
- `partner.devices.getDeviceInfo`
- `partner.tickets.getTickets`

Device:
- `device.device-info.getDeviceInfo`
- `device.telemetries.sendTelemetry`
- `device.device-info.setCloudSettings`

## Multi-tenant Determinism

- Always pass `--tenant <tenant-id>` for automation.
- Prefer `--output-mode envelope` for machine loops to capture request/guard/retry metadata.
- Use `xyte-cli tenant use <tenant-id>` only for interactive/default context.
- Keep auth explicit with named slots:
  - `xyte-cli auth key list --tenant <tenant-id> --format json`
  - `xyte-cli auth key use --tenant <tenant-id> --provider <provider> --slot <id|name>`

## Utility

Generate a fresh query/filter report from spec:

```bash
skills/xyte-cli/scripts/endpoint_filters_report.sh
```
