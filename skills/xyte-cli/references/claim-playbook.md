# Claim Playbook (Native, Edge, C2C)

Consolidated agent reference for claiming devices into an Xyte tenant. Load this when the user mentions "claim".

## 0. Mandatory disambiguation

When the user says "claim device(s)" without specifying the path, STOP. Do not guess from spreadsheet columns, device model, or prior context. Ask this verbatim and wait:

> Which claim path applies?
> 1. Native / direct — the device is on the same network as the platform and you have its serial number, MAC, and cloud id (`organization.devices.claimDevice`).
> 2. Edge — the device sits behind an Xyte Edge proxy and is identified by its IP plus a device model id (`organization.edge.startClaim`).
>
> If you meant Cloud-to-Cloud (C2C) claiming, that is not available via the public API today — use the End Customer Portal.

When the user explicitly asks about C2C claiming, reply verbatim:

> Cloud-to-Cloud (C2C) claiming is not available via the public Xyte API today. Please claim C2C devices from the End Customer Portal.

Never invent a C2C endpoint.

## 1. Native / direct claim — `organization.devices.claimDevice`

Required body fields: `name`, `space_id` (integer), `sn`, `mac`, `cloud_id`.

One device:

```bash
xyte-cli api call organization.devices.claimDevice \
  --tenant <tenant-id> \
  --body-json '{"name":"<name>","space_id":<space-id>,"sn":"<sn>","mac":"<mac>","cloud_id":"<cloud-id>"}'
```

Bulk (AI-preprocessed spreadsheet):

```bash
xyte-cli util prepare --action organization.devices.claimDevice \
  --input ./raw.xlsx --tenant <tenant-id> --output-dir ./prepared
```

Then call `organization.devices.claimDevice` once per row from `prepared/claim-primary.csv`. Review `prepared/claim-rejected.csv` first.

Failure handling:
- 422 with field detail → row is malformed; fix and re-run.
- 422 "already claimed" → already claimed under the tenant; safe to skip.
- 401 → auth issue; run `xyte-cli setup run` or `xyte-cli config key list`.

## 2. Edge claim — `organization.edge.startClaim` (async)

Required body fields: `proxy_id`, `device_ip`, `device_model_id`, `space_id` (integer). Optional: `display_name`, `custom_parameters`, `custom_partner_name`, `custom_model_name`, `skip_connectivity_check`.

Heartbeat model id: `5dc4ba6c-c323-4118-a4e4-504f074426f2`. `proxy_id` lives in the End Customer Portal.

Preflight for non-heartbeat Edge models:
1. Run `xyte-cli edge models --tenant <tenant-id> --search <model-or-vendor>` to find candidate model ids.
2. Run `xyte-cli edge model --tenant <tenant-id> <device-model-id>` to inspect required `parameters` and command metadata.
3. Put `parameters[].name` values into `custom_parameters`; do not use labels as keys.
4. If `proxy_id` is unknown, read proxy records with `xyte-cli api call organization.edges.getEdges --tenant <tenant-id> --query-json '{"page":1,"per_page":100}'`.
5. Reject or ask for missing required parameter values such as `{$DEVICE_ID}` before `edge claim --plan` or `edge claim-batch --plan`.

Lifecycle: `startClaim` returns 204, then poll `getClaimStatus` until `result` is `success` or `failed`.

Connectivity check rule:
- Single `edge claim` keeps the API default unless `--skip-connectivity-check` is passed.
- Batch `edge claim-batch` runs `edge ping` internally before `startClaim` for blank or `skip_connectivity_check=false` rows.
- Batch rows with `skip_connectivity_check=true` skip the internal ping and send `skip_connectivity_check: true`.
- Standalone `edge ping` is diagnostic; do not treat a prior ping command as evidence consumed by batch claim.

### 2a. Single edge device

```bash
xyte-cli edge claim \
  --tenant <tenant-id> \
  --proxy-id <proxy-id> \
  --device-ip <device-ip> \
  --device-model-id <device-model-id> \
  --space-id <space-id> \
  [--display-name <name>] \
  [--skip-connectivity-check] \
  [--poll-interval-ms 5000] \
  [--poll-timeout-ms 600000] \
  --plan
# after user approves:
xyte-cli edge claim --tenant <tenant-id> ... --apply
```

Peek current state without initiating:

```bash
xyte-cli edge claim-status --tenant <tenant-id> --proxy-id <proxy-id> --device-ip <device-ip>
```

### 2a.1. Update an already-claimed Edge device address

Use `xyte-cli edge update-hostname`, not generic `organization.devices.updateDevice`, when changing the IP/hostname monitored by an Edge proxy.

```bash
xyte-cli edge update-hostname --tenant <tenant-id> --device-id <device-id> --device-ip <new-ip-or-hostname> --plan
xyte-cli edge update-hostname --tenant <tenant-id> --device-id <device-id> --device-ip <new-ip-or-hostname> --apply
```

Unless `--skip-connectivity-check` is passed, the backend requires a successful connectivity check for the new address. The endpoint preserves existing custom parameter values.

### 2b. Bulk edge claim (north star)

```bash
xyte-cli util prepare --action organization.edge.startClaim \
  --input ./edge-devices.xlsx --tenant <tenant-id> --output-dir ./prepared
# outputs: prepared/organization-edge-startclaim.csv, organization-edge-startclaim.rejected.csv, organization-edge-startclaim.notes.md

xyte-cli edge claim-batch \
  --tenant <tenant-id> \
  --input ./prepared/organization-edge-startclaim.csv \
  --report ./artifacts/edge-claim-report.ndjson \
  --plan

# After explicit user approval:
xyte-cli edge claim-batch \
  --tenant <tenant-id> \
  --input ./prepared/organization-edge-startclaim.csv \
  --report ./artifacts/edge-claim-report.ndjson \
  --resume-artifact ./artifacts/edge-claim.resume.ndjson \
  --apply
```

To skip batch-owned pre-claim ping for blank rows, add `--skip-connectivity-check`. If any row explicitly says `skip_connectivity_check=false`, the batch rejects that row as a conflict instead of overriding it.

Resume an interrupted run (ctrl-C, network blip, partial failure):

```bash
xyte-cli edge claim-batch \
  --tenant <tenant-id> \
  --input ./prepared/organization-edge-startclaim.csv \
  --report ./artifacts/edge-claim-report.ndjson \
  --resume-artifact ./artifacts/edge-claim.resume.ndjson \
  --apply
```

Replaying after all rows are terminal-success is a no-op (exit 0, zero API calls).

### 2c. Edge ping (connectivity probe)

```bash
xyte-cli edge ping --tenant <tenant-id> --proxy-id <proxy-id> --device-ip <device-ip> --plan
# after user approves:
xyte-cli edge ping --tenant <tenant-id> --proxy-id <proxy-id> --device-ip <device-ip> --apply
xyte-cli edge ping-status --tenant <tenant-id> --proxy-id <proxy-id> --device-ip <device-ip>
```

`ping` is async with the same poll semantics as claim.

## 3. Cloud-to-Cloud (C2C) — not supported

The public Xyte API does not expose C2C claiming today. Do not invent an endpoint; do not route through `organization.devices.claimDevice` or `organization.edge.startClaim` as a workaround. Tell the user:

> Cloud-to-Cloud (C2C) claiming is not available via the public Xyte API today. Please claim C2C devices from the End Customer Portal.

## 4. Edge-case matrix (must-know decision tree)

| # | Scenario | Disposition | Agent action |
|---|---|---|---|
| 1 | `startClaim` → 204, `getClaimStatus` stays `pending` past timeout | `timeout` | Report timeout + last payload; increase `--poll-timeout-ms` for slow claims. Resume retries the row rather than checkpointing the in-flight claim. |
| 2 | `getClaimStatus` → `failed` | `failed` | Surface server-side message; batch continues. |
| 3 | `startClaim` → 422 (unknown model id, unreachable edge, bad IP) | `rejected` | Mark row rejected; do not poll. |
| 4 | `startClaim` → 401 | `aborted` | Abort the whole flow; point user at `xyte-cli setup run` / `config key`. |
| 5 | Device already claimed behind the same edge | `already-claimed` | Skip row; batch continues. |
| 6 | Proxy offline (terminal-failed or 422 "edge offline") | `proxy-offline` | Group in summary for retry-after-fix; run `xyte-cli edge ping` to confirm before re-running. |
| 7 | Batch pre-claim ping rejected/failed/timed out | `ping-failed` | Surface ping result; do not call `startClaim`; resume retries the row. |
| 8 | N-of-M rows succeed | exit 1 | Per-row NDJSON report via `--report`; rerun with `--resume-artifact`. |
| 9 | Resume after ctrl-C | — | `--resume-artifact` skips rows previously recorded as `succeeded` or `already-claimed` and re-runs all other rows. It records row results, not in-flight claim IDs. |
| 10 | Malformed CSV/XLSX | — | `util prepare` routes bad rows to `organization-edge-startclaim.rejected.csv`; batch refuses to start on schema violations. |
| 11 | `startClaim` → 429 | — | Exponential backoff w/ jitter; honor `Retry-After`. |
| 12 | `getClaimStatus` → 422 "not initiated" (race against 204) | — | Tolerate a bounded number of 422-not-initiated on first polls; real 422 thereafter is a hard reject. |
| 13 | Long-running claim > default timeout | — | `--poll-timeout-ms` / `--poll-interval-ms` overrides. |
| 14 | Ping analog of (1)-(3) | — | Same primitives, same dispositions. |
| 15 | Mixed `proxy_id` rows in one batch | — | Supported; rows keep CSV order. There is no per-proxy fan-out or in-flight claim queue. |
| 16 | `--plan` over batch | — | Zero API calls; exits 0 only if plan is clean. |
| 17 | Output format | — | All edge commands honor `--output json\|text`. |
| 18 | Logs | — | Every mutating call lands in `xyte-cli logs list`; use `logs show --entry <sessionId>:<seq>` or `logs show --request-id <id>` for exact lookup. |
| 19 | Idempotent resume after full success | exit 0 | No API calls. |
| 20 | Multi-tenant | — | Always pass `--tenant <tenant-id>`. |

## 5. Safety defaults

- `edge claim`, `edge claim-batch`, `edge ping` → mutating; `--plan` first, `--apply` only after explicit user approval.
- `edge claim-status`, `edge ping-status` → read-only.
- Never run `edge claim-batch` again without `--resume-artifact` on a half-finished run. Resume prevents re-sending rows already recorded as `succeeded` or `already-claimed`, but it does not protect a row whose `startClaim` was sent and then the process died before the result was written.
- Poll defaults: 5 s interval, 10 min timeout.

## 6. Summary contracts

- `xyte.edge.claim-batch.v1` — batch summary returned on stdout JSON and flow artifacts. Fields: `schemaVersion`, `generatedAtUtc`, `tenantId`, `mode`, `runId`, `reportPath?`, `resumePath?`, `totals` (per disposition, including `pingFailed`), `stoppedEarly`, `abortDetail?`, `rows[]`. Rows may include `planned` in plan mode and `preClaimPing` when batch performed a pre-claim ping.
- `--report` — per-row audit NDJSON. Use it for review/debugging.
- `--resume-artifact` — completed row resume state NDJSON. Reuse this path when resuming a partial batch; it does not checkpoint in-flight claim IDs.
- `xyte.edge.ping.v1` — single-probe result.
