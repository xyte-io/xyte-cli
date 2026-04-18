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

Lifecycle: `startClaim` returns 204, then poll `getClaimStatus` until `result` is `success` or `failed`.

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
| 1 | `startClaim` → 204, `getClaimStatus` stays `pending` past timeout | `timeout` | Report `claim_timeout` + last payload; offer `--resume-artifact` to re-poll. |
| 2 | `getClaimStatus` → `failed` | `failed` | Surface server-side message; batch continues. |
| 3 | `startClaim` → 422 (unknown model id, unreachable edge, bad IP) | `rejected` | Mark row rejected; do not poll. |
| 4 | `startClaim` → 401 | `aborted` | Abort the whole flow; point user at `xyte-cli setup run` / `config key`. |
| 5 | Device already claimed behind the same edge | `already-claimed` | Skip row; batch continues. |
| 6 | Proxy offline (terminal-failed or 422 "edge offline") | `proxy-offline` | Group in summary for retry-after-fix; run `xyte-cli edge ping` to confirm before re-running. |
| 7 | `skip_connectivity_check=false` and ping fails mid-claim | `failed` | Surface both claim id and ping reason. |
| 8 | N-of-M rows succeed | exit 1 | Per-row disposition CSV; rerun with `--resume-artifact`. |
| 9 | Resume after ctrl-C | — | `--resume-artifact` skips terminal rows, re-polls pending, reinitiates nothing already initiated. |
| 10 | Malformed CSV/XLSX | — | `util prepare` routes bad rows to `organization-edge-startclaim.rejected.csv`; batch refuses to start on schema violations. |
| 11 | `startClaim` → 429 | — | Exponential backoff w/ jitter; honor `Retry-After`. |
| 12 | `getClaimStatus` → 422 "not initiated" (race against 204) | — | Tolerate a bounded number of 422-not-initiated on first polls; real 422 thereafter is a hard reject. |
| 13 | Long-running claim > default timeout | — | `--poll-timeout-ms` / `--poll-interval-ms` overrides. |
| 14 | Ping analog of (1)-(3) | — | Same primitives, same dispositions. |
| 15 | Mixed `proxy_id` rows in one batch | — | Grouped per proxy for logging, not serialized across proxies. |
| 16 | `--plan` over batch | — | Zero API calls; exits 0 only if plan is clean. |
| 17 | Output format | — | All edge commands honor `--output json\|text`. |
| 18 | Logs | — | Every mutating call lands in `xyte-cli logs list`; batch shares one logical run id. |
| 19 | Idempotent resume after full success | exit 0 | No API calls. |
| 20 | Multi-tenant | — | Always pass `--tenant <tenant-id>`. |

## 5. Safety defaults

- `edge claim`, `edge claim-batch`, `edge ping` → mutating; `--plan` first, `--apply` only after explicit user approval.
- `edge claim-status`, `edge ping-status` → read-only.
- Never run `edge claim-batch` again without `--resume-artifact` on a half-finished run — you'll double-initiate terminal-success rows (current server behavior: second claim for an already-claimed device returns `already-claimed`, but resume is faster and cleaner).
- Poll defaults: 5 s interval, 10 min timeout.

## 6. Summary contracts

- `xyte.edge.claim-batch.v1` — batch summary written to `--report` NDJSON and stdout JSON. Fields: `schemaVersion`, `generatedAtUtc`, `tenantId`, `mode`, `runId`, `reportPath?`, `resumePath?`, `totals` (per disposition), `stoppedEarly`, `abortDetail?`, `rows[]`.
- `xyte.edge.ping.v1` — single-probe result.
