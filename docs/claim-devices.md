# Claim Devices (Native, Edge, C2C)

One tutorial covering every device-claim path `xyte-cli` exposes, plus the C2C path the CLI deliberately does **not** expose. Use this as the first stop when you or an AI agent reads "claim device(s)".

## 0. Which claim path do I need?

When someone says "claim a device", they mean one of three things. Pick the column from the table below that matches what you have in hand. If you are not sure which applies, read the rows carefully — never guess based on whichever columns a spreadsheet happens to have.

| Question | Native / direct | Edge | Cloud-to-Cloud (C2C) |
| --- | --- | --- | --- |
| Where does the device sit? | Same network as the platform | Behind an Xyte Edge proxy | A third-party cloud |
| What identifies it? | Serial number + MAC + cloud id | Proxy id + device IP + device model id | Vendor account + vendor-side device id |
| CLI command | `xyte-cli api call organization.devices.claimDevice` | `xyte-cli edge claim` / `edge claim-batch` | *Not available in the public API today.* |
| Catalog key | `organization.devices.claimDevice` | `organization.edge.startClaim` | None |
| Bulk pipeline | `xyte-cli util prepare --action organization.devices.claimDevice` | `xyte-cli util prepare --action organization.edge.startClaim` → `xyte-cli edge claim-batch` | Use the End Customer Portal |

**AI-agent rule (mandatory).** If the user did not specify native vs edge vs C2C, ask them which path applies before running anything. Do not auto-pick based on column names or device model. The exact question the skill uses verbatim:

> Which claim path applies?
> 1. Native / direct — the device is on the same network as the platform and you have its serial number, MAC, and cloud id (`organization.devices.claimDevice`).
> 2. Edge — the device sits behind an Xyte Edge proxy and is identified by its IP plus a device model id (`organization.edge.startClaim`).
>
> If you meant Cloud-to-Cloud (C2C) claiming, that is not available via the public API today — use the End Customer Portal.

## 1. Native / direct claim

Prerequisites: known `sn`, `mac`, `cloud_id`, and `space_id`.

Single device:

```bash
xyte-cli api call organization.devices.claimDevice \
  --tenant <tenant-id> \
  --body-json '{
    "name":"Room 101 Display",
    "space_id": 10000,
    "sn":"<serial-number>",
    "mac":"<mac>",
    "cloud_id":"<cloud-id>"
  }'
```

Bulk (spreadsheet-driven):

```bash
xyte-cli util prepare \
  --action organization.devices.claimDevice \
  --input ./raw-claims.xlsx \
  --tenant <tenant-id> \
  --output-dir ./prepared

# Review ./prepared/organization-devices-claimdevice.rejected.csv, then:
# iterate ./prepared/organization-devices-claimdevice.csv and call the endpoint per row.
```

Common failure modes:
- 422 with field detail → row is malformed; fix and re-run.
- 422 "already claimed" → already claimed under this tenant; skip safely.
- 401 → auth; run `xyte-cli setup run` or check `xyte-cli config key list`.

## 2. Edge claim (north star bulk workflow)

Prerequisites: `proxy_id` (from the End Customer Portal), `device_ip`, `device_model_id`, `space_id`. Heartbeat model id: `5dc4ba6c-c323-4118-a4e4-504f074426f2`.

Edge claim is **asynchronous** — `startClaim` returns 204, then the CLI polls `getClaimStatus` until terminal (`success` or `failed`). Default poll: 5 s interval, 10 min timeout.

### 2a. Single edge device

```bash
# Dry-run first:
xyte-cli edge claim \
  --tenant <tenant-id> \
  --proxy-id <proxy-id> \
  --device-ip 192.168.1.100 \
  --device-model-id 5dc4ba6c-c323-4118-a4e4-504f074426f2 \
  --space-id 10000 \
  --display-name "Room 101 Heartbeat" \
  --plan

# Apply only after explicit approval:
xyte-cli edge claim \
  --tenant <tenant-id> \
  --proxy-id <proxy-id> \
  --device-ip 192.168.1.100 \
  --device-model-id 5dc4ba6c-c323-4118-a4e4-504f074426f2 \
  --space-id 10000 \
  --display-name "Room 101 Heartbeat" \
  --apply
```

Peek at current state without initiating:

```bash
xyte-cli edge claim-status --tenant <tenant-id> --proxy-id <proxy-id> --device-ip 192.168.1.100
```

### 2b. Bulk edge claim (the one command to run)

```bash
# Step 1 — prepare a messy spreadsheet into a deterministic primary CSV + rejected CSV:
xyte-cli util prepare \
  --action organization.edge.startClaim \
  --input ./edge-devices.xlsx \
  --tenant <tenant-id> \
  --output-dir ./prepared

# Step 2 — review ./prepared/organization-edge-startclaim.rejected.csv and fix any row with a reject_reason.

# Step 3 — dry-run (zero API calls; verifies every row plans cleanly):
xyte-cli edge claim-batch \
  --tenant <tenant-id> \
  --input ./prepared/organization-edge-startclaim.csv \
  --report ./artifacts/edge-claim-report.ndjson \
  --plan

# Step 4 — apply, only after explicit operator approval:
xyte-cli edge claim-batch \
  --tenant <tenant-id> \
  --input ./prepared/organization-edge-startclaim.csv \
  --report ./artifacts/edge-claim-report.ndjson \
  --resume-artifact ./artifacts/edge-claim.resume.ndjson \
  --apply
```

Batch connectivity behavior:
- Blank or `skip_connectivity_check=false` rows run an internal `edge ping` before `startClaim`.
- `skip_connectivity_check=true` rows skip that ping and send `skip_connectivity_check: true` to `startClaim`.
- `--skip-connectivity-check` applies skip mode to blank rows; explicit row `false` values are rejected as conflicts.
- Standalone `edge ping` is diagnostic. It is not a required evidence-producing prerequisite for a later batch claim.

Exit codes:
- `0` — every row ended in `succeeded` or `already-claimed`.
- `1` — one or more rows ended in `failed`, `rejected`, `timeout`, `proxy-offline`, `ping-failed`, or `aborted`; fix them and resume.

Resume after interruption (ctrl-C, network blip, partial failure):

```bash
xyte-cli edge claim-batch \
  --tenant <tenant-id> \
  --input ./prepared/organization-edge-startclaim.csv \
  --report ./artifacts/edge-claim-report.ndjson \
  --resume-artifact ./artifacts/edge-claim.resume.ndjson \
  --apply
```

Replaying after all rows are terminal-success is a no-op (exit 0, zero API calls).

### 2c. Connectivity probe (Edge ping)

Same async pattern as claim:

```bash
xyte-cli edge ping --tenant <tenant-id> --proxy-id <proxy-id> --device-ip 192.168.1.100 --plan
# Apply only after explicit approval:
xyte-cli edge ping --tenant <tenant-id> --proxy-id <proxy-id> --device-ip 192.168.1.100 --apply
xyte-cli edge ping-status --tenant <tenant-id> --proxy-id <proxy-id> --device-ip 192.168.1.100
```

## 3. Cloud-to-Cloud (C2C) — not supported

Cloud-to-Cloud claiming is not available via the public Xyte API today. Do not invent an endpoint, do not route through `organization.devices.claimDevice` or `organization.edge.startClaim` as a workaround. For C2C devices, use the End Customer Portal.

AI agents must use this exact phrasing:

> Cloud-to-Cloud (C2C) claiming is not available via the public Xyte API today. Please claim C2C devices from the End Customer Portal.

## 4. Troubleshooting (edge-claim decision tree)

| Situation | Disposition | Do this |
| --- | --- | --- |
| `startClaim` 204, `getClaimStatus` stays `pending` past timeout | `timeout` | Re-run with a higher `--poll-timeout-ms`, or resume via `--resume-artifact`. |
| `getClaimStatus` → `failed` | `failed` | Read the server detail; fix at source; resume. |
| `startClaim` → 422 (unknown model id, unreachable edge, bad IP) | `rejected` | Fix the offending field in your primary CSV; resume. |
| `startClaim` → 401 | `aborted` | Run `xyte-cli setup run` or `xyte-cli config key list`; resume. |
| Already claimed | `already-claimed` | No action — batch exits clean if every row is success or already-claimed. |
| Proxy offline | `proxy-offline` | Bring the proxy online; re-run with `--resume-artifact`. |
| Batch pre-claim ping fails or times out | `ping-failed` | Check network/firewall; resume after fixing connectivity. |
| `skip_connectivity_check=true` and claim later fails connectivity verification | `rejected` or `failed` | Inspect the row response; rerun without skip if the device must be verified first. |
| `startClaim` → 429 | retried | CLI backs off automatically; no action. |
| `getClaimStatus` → 422 "not initiated" race | tolerated | CLI tolerates a bounded number of first-poll 422s; no action. |
| Half-finished batch | — | Always use `--resume-artifact` on the next run. |
| Malformed spreadsheet | — | Fix rejects in `./prepared/organization-edge-startclaim.rejected.csv` and re-run `util prepare`. |
| Mixed proxies in one batch | — | Supported; rows are grouped per proxy for logging. |
| Multi-tenant | — | Always pass `--tenant <tenant-id>`. |

## 5. Logs and audit

Every mutating `edge claim` / `edge claim-batch` / `edge ping` command lands in `xyte-cli logs list`. A batch shares one logical run id so you can trace every row back to a single operator invocation.

```bash
xyte-cli logs list --session-id <session-id> --output text
xyte-cli logs show --entry <session-id>:<seq> --output json
xyte-cli logs show --request-id <request-id> --output json
```
