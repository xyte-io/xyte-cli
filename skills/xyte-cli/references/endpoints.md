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
| `organization.devices.getDevices` | `page`, `per_page`, `space_id` | `page`, `per_page` | Filter devices by one space; shared docs mention `has_next_page`, live Verve/Playground responses returned `next_page`; handle either continuation field |
| `organization.devices.getHistories` | `status`, `from`, `to`, `device_id`, `space_id`, `name` | none | Filtered history lookup; can be time-windowed |
| `organization.commands.getCommands` | `status`, `page`, `per_page` | `page`, `per_page` | Command history pagination and status filter |
| `organization.incidents.getIncidents` | `from`, `to`, `status`, `priority`, `title`, `description`, `issue`, `device_model`, `partner_name`, `sub_model`, `space_id`, `page`, `per_page` | `page`, `per_page` | Incident filtering matrix. Use integer `from` and `to`; for reliable active-incident fetches use both (`from=0`, `to=<now>`). |
| `organization.notes.getAllDeviceNotes` | `page`, `per_page` | `page`, `per_page` | Paginated notes across all devices |
| `organization.notes.getAllSpaceNotes` | `page`, `per_page` | `page`, `per_page` | Paginated notes across all spaces |
| `organization.notes.getDeviceNotes` | `page`, `per_page` | `page`, `per_page` | Paginated notes for one device; path `device_id` |
| `organization.notes.getSpaceNotes` | `page`, `per_page` | `page`, `per_page` | Paginated notes for one space; path `space_id` |
| `organization.edges.getEdges` | `page`, `per_page` | `page`, `per_page` | Paginated Edge records |
| `organization.groups.getGroups` | `page`, `per_page` | `page`, `per_page` | Paginated team access groups |
| `organization.users.getUsers` | `page`, `per_page` | `page`, `per_page` | Paginated active users |
| `organization.models.getModels` | `page`, `per_page`, `search`, `edge_only` | `page`, `per_page` | Use `edge_only=true` for Edge model discovery and custom parameter labels |

For the complete current query-param set, run `xyte-cli api endpoints describe <endpoint-key>` before calling.

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

Prefer `flow.device-command` for user requests like "send command X to device Y"; it first reads `organization.devices.getDevice`, describes the returned model with `organization.models.getModel`, validates the selected `commands[].name` plus any command parameters, maps select labels to the exact model-defined values, and pauses before `organization.commands.sendCommand`. Send request values under `extra_params`; `params` is response/history data and is rejected in a raw send body.

```bash
xyte-cli flow run flow.device-command --tenant <tenant-id> --plan --var device_id=<device-id> --var command=reboot

# Add these vars only when command queue/history polling is wanted:
xyte-cli flow run flow.device-command --tenant <tenant-id> --apply --var device_id=<device-id> --var command=reboot --var command_poll=true --var command_poll_timeout_ms=60000

xyte-cli api call organization.devices.getDevice \
  --tenant <tenant-id> \
  --path-json '{"device_id":"<device-id>"}'

xyte-cli edge models describe \
  --tenant <tenant-id> \
  --model-id <model-id-from-device>

xyte-cli api call organization.commands.sendCommand \
  --tenant <tenant-id> \
  --path-json '{"device_id":"<device-id>"}' \
  --body-json '{"name":"reboot","extra_params":{}}'

xyte-cli api call organization.commands.getCommands \
  --tenant <tenant-id> \
  --path-json '{"device_id":"<device-id>"}' \
  --query-json '{"page":1,"per_page":500}'
```

Optional flow polling matches only the id returned by `sendCommand` and reports Xyte command queue/history status.

### `organization.devices.mergeDevice` / `organization.devices.splitDevice`

Run only after explicit user approval. Merge attaches shadow devices to a primary device; split detaches one shadow device from its primary.

```bash
xyte-cli api call organization.devices.mergeDevice \
  --tenant <tenant-id> \
  --path-json '{"device_id":"<primary-device-id>"}' \
  --body-json '{"with_device_ids":["<shadow-device-id>"]}' \
  --note "approved merge"

xyte-cli api call organization.devices.splitDevice \
  --tenant <tenant-id> \
  --path-json '{"device_id":"<primary-device-id>"}' \
  --body-json '{"shadow_device_id":"<shadow-device-id>"}' \
  --note "approved split"
```

### `organization.devices.suspendIncidents` / `organization.devices.resumeIncidents`

```bash
xyte-cli api call organization.devices.suspendIncidents \
  --tenant <tenant-id> \
  --path-json '{"device_id":"<device-id>"}'

xyte-cli api call organization.devices.resumeIncidents \
  --tenant <tenant-id> \
  --path-json '{"device_id":"<device-id>"}'
```

### `organization.notes.*`

Read notes with pagination. Create and delete notes only after explicit user approval; API-created notes have `created_by: null` because raw API calls carry no user context.

```bash
xyte-cli api call organization.notes.getDeviceNotes \
  --tenant <tenant-id> \
  --path-json '{"device_id":"<device-id>"}' \
  --query-json '{"page":1,"per_page":100}'

xyte-cli api call organization.notes.createDeviceNote \
  --tenant <tenant-id> \
  --path-json '{"device_id":"<device-id>"}' \
  --body-json '{"content":"Mounted behind the left panel."}'

xyte-cli api call organization.notes.deleteDeviceNote \
  --tenant <tenant-id> \
  --path-json '{"device_id":"<device-id>","id":"<note-id>"}'

xyte-cli api call organization.notes.getSpaceNotes \
  --tenant <tenant-id> \
  --path-json '{"space_id":"<space-id>"}' \
  --query-json '{"page":1,"per_page":100}'
```

### `organization.groups.addUsers`

```bash
xyte-cli api call organization.groups.addUsers \
  --tenant <tenant-id> \
  --path-json '{"id":"<group-id>"}' \
  --body-json '{"user_ids":["<user-id>"]}'
```

### `partner.organizations.createOrganization`

```bash
xyte-cli api call partner.organizations.createOrganization \
  --tenant <tenant-id> \
  --body-json '{"name":"Acme HQ","admin_contact_email":"admin@example.com","admin_contact_name":"Jane Doe","finance_contact_email":"finance@example.com","finance_contact_name":"Finance Team"}'
```

## Common Endpoint Keys

Organization:
- `organization.devices.getDevices`
- `organization.devices.getDevice`
- `organization.devices.claimDevice` (native claim)
- `organization.devices.mergeDevice`
- `organization.devices.splitDevice`
- `organization.devices.suspendIncidents`
- `organization.devices.resumeIncidents`
- `organization.incidents.closeIncident`
- `organization.incidents.getIncidents`
- `organization.notes.getAllDeviceNotes`
- `organization.notes.getAllSpaceNotes`
- `organization.notes.getDeviceNotes`
- `organization.notes.getSpaceNotes`
- `organization.notes.createDeviceNote`
- `organization.notes.createSpaceNote`
- `organization.notes.deleteDeviceNote`
- `organization.notes.deleteSpaceNote`
- `organization.edges.getEdges`
- `organization.groups.getGroups`
- `organization.groups.addUsers`
- `organization.users.getUsers`
- `organization.users.createUser`
- `organization.tickets.getTickets`
- `organization.commands.sendCommand`
- `organization.edge.startClaim` (edge claim — async, poll with `getClaimStatus`)
- `organization.edge.getClaimStatus`
- `organization.edge.startPing` (edge connectivity probe — async, poll with `getPingStatus`)
- `organization.edge.getPingStatus`

Partner:
- `partner.devices.getDevices`
- `partner.devices.getDeviceInfo`
- `partner.organizations.createOrganization`
- `partner.tickets.getTickets`

## Edge Devices (Async)

Edge devices sit behind an Xyte Edge proxy. Claim/ping are **asynchronous**: the start endpoint returns 204, then you poll the matching status endpoint until terminal (`success` or `failed`). Prefer the `xyte-cli edge` command group or `flow.edge-claim*` flows over raw `api call` — they handle polling, backoff, and resume.

Model discovery:
- `organization.models.getModels` -> `GET /core/v1/organization/models` with `edge_only=true`, `page`, `per_page`, and optional `search`.
- `organization.models.getModel` -> `GET /core/v1/organization/models/:id`; returns `parameters[]` and model-supported `commands[]`.
- Use `parameters[].name` as the accepted `custom_parameters` labels for Edge claim and already-claimed parameter updates.
- Use `commands[].name` or `commands[].friendly_name` for `organization.commands.sendCommand`; use `commands[].custom_fields[].name` for `extra_params`, map select labels through the field's own options, and provide `file_id` when `commands[].with_file` is true.

Verified raw route mapping:
- `organization.edge.startClaim` -> `POST /core/v1/organization/edges/devices/start_claim`
- `organization.edge.getClaimStatus` -> `GET /core/v1/organization/edges/devices/get_claim_status`
- `organization.edge.startPing` -> `POST /core/v1/organization/edges/devices/start_ping`
- `organization.edge.getPingStatus` -> `GET /core/v1/organization/edges/devices/get_ping_status`

### `organization.edge.startClaim` + `organization.edge.getClaimStatus`

```bash
xyte-cli api call organization.edge.startClaim \
  --tenant <tenant-id> \
  --body-json '{
    "proxy_id":"<proxy-id>",
    "device_ip":"192.168.1.100",
    "device_model_id":"<device-model-id>",
    "space_id":<space-id>,
    "display_name":"Conference Room Display",
    "mac":"aa:bb:cc:dd:ee:ff",
    "sn":"SN-12345",
    "skip_connectivity_check":false
  }'

xyte-cli api call organization.edge.getClaimStatus \
  --tenant <tenant-id> \
  --query-json '{"proxy_id":"<proxy-id>","device_ip":"192.168.1.100"}'
```

### `organization.edge.startPing` + `organization.edge.getPingStatus`

```bash
xyte-cli api call organization.edge.startPing \
  --tenant <tenant-id> \
  --body-json '{"proxy_id":"<proxy-id>","device_ip":"192.168.1.100"}'

xyte-cli api call organization.edge.getPingStatus \
  --tenant <tenant-id> \
  --query-json '{"proxy_id":"<proxy-id>","device_ip":"192.168.1.100"}'
```

Ergonomic wrappers (recommended):
- Model discovery: `xyte-cli edge models list --tenant <tenant-id> --page 1 --per-page 100` and `xyte-cli edge models describe --tenant <tenant-id> --model-id <model-id>`.
- Single claim: `xyte-cli edge claim --plan`, then `--apply` after explicit approval.
- Bulk claim: `xyte-cli edge claim-batch --input <primary-csv> --plan [--skip-connectivity-check]`, then `--apply --resume-artifact <path>` after explicit approval.
- In bulk claim, blank or `skip_connectivity_check=false` rows run an internal pre-claim ping; standalone `edge ping` is diagnostic.
- Batch resume skips completed rows from `--resume-artifact`; it does not store in-flight claim IDs.

### Already-Claimed Edge `custom_parameters`

Use `organization.devices.updateDevice` for already-claimed Edge custom parameters only through the dedicated CLI wrappers unless the user explicitly requests raw calls:

```bash
xyte-cli edge update-params --tenant <tenant-id> --device-id <device-id> --set-json '{"Port":"161"}' --plan
xyte-cli edge update-params-batch --tenant <tenant-id> --input ./prepared/edge-params-update.csv --plan --report ./artifacts/edge-params.plan.ndjson
```

Safety rules:
- `custom_parameters` is a complete replacement write. The request body must include every value to preserve.
- The wrapper reads `organization.devices.getDevice`, reads `organization.models.getModel`, validates keys against `parameters[].name`, merges requested changes into current values, sends `{"custom_parameters": ...}` to `organization.devices.updateDevice`, and verifies with `getDevice`.
- Block unknown requested labels, unsupported existing labels, missing required model parameters, duplicate `device_id` batch rows, model mismatch, read-back mismatch, and masked password placeholders (`"*****"`) unless a real replacement value is supplied.
- Status peek: `xyte-cli edge claim-status`, `xyte-cli edge ping-status`
- Connectivity probe: `xyte-cli edge ping --plan`, then `--apply` after explicit approval.

See `references/claim-playbook.md` for the full decision tree and `references/flow-recipes.md` for flow-level recipes.

## Util Prepare + Import Tree

```bash
# discover preprocess actions
xyte-cli util list-actions --output text --mode friendly

# scaffold canonical files for one action
xyte-cli util prepare --action organization.devices.claimDevice --input ./raw-source.xlsx --output-dir ./prepared

# scaffold and execute dedicated utility workflows
xyte-cli util prepare --action space.import-tree --input ./raw-tree.pdf --output-dir ./prepared
xyte-cli util import-tree --tenant <tenant-id> --input ./prepared/space-import-tree.csv
xyte-cli util import-tree --tenant <tenant-id> --input ./prepared/space-import-tree.csv --apply --report ./artifacts/space-import.ndjson

xyte-cli util prepare --action organization.edge.startClaim --input ./edge-devices.xlsx --output-dir ./prepared
xyte-cli edge claim-batch --tenant <tenant-id> --input ./prepared/organization-edge-startclaim.csv --plan
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
