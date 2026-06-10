---
name: xyte-cli
description: "Use for @xyteai/cli operations: first-run setup, config/tenant/key management, api endpoint calls, ops inspection/reporting, util preprocessing/import-tree execution, and JSON-only headless console snapshots."
---

# XYTE Skill Router (One-Stop, Agent-Native)

Last updated: 2026-04-17

This skill is the entrypoint for deterministic Xyte operations via `xyte-cli`.

## Invocation Rules

- Use `xyte-cli` commands directly.
- Do not use source/dev entrypoints (`tsx`, `src/*`, `dist/*`, `bin/*`).
- If `xyte-cli` is unavailable on `PATH`, run `npx -y @xyteai/cli@latest doctor environment --format json` and use the command prefix from `recommendations`; `npm exec -- @xyteai/cli@latest <command>` also works until `PATH` is fixed.
- Command option correctness:
  - `xyte-cli config tenant list` has no `--output`.
  - `xyte-cli setup status`, `xyte-cli config doctor`, `xyte-cli status`, `xyte-cli ops inspect`, and `xyte-cli ops console --headless` accept `--output json|text` where relevant.
  - `xyte-cli ops inspect fleet|deep-dive` support `--provider-scope organization|partner|auto`.
  - `xyte-cli ops inspect fleet|deep-dive` and `xyte-cli ops watch incidents` support `--out <path>`.
  - `xyte-cli flow run` supports `--inspect-provider-scope organization|partner|auto`.
- For fresh users in a new environment, verify readiness with:
  - `xyte-cli status --mode fast --output json`
  - `xyte-cli init --scope both --agents all --force --no-setup`
- for humans: `xyte-cli setup run --tenant <tenant-id> [--provider <xyte-org|xyte-partner>]`
- for automation: use `--key-file <path-outside-workspace>` or pipe the key on stdin to `xyte-cli setup run --non-interactive --tenant <tenant-id> [--provider <xyte-org|xyte-partner>] --key-stdin`
- for secret managers: use `--key-command "<cmd>"` to resolve the API key from any CLI that prints it on stdout, e.g. `--key-command "op read op://Employee/Xyte/credential"` (1Password), `--key-command "vault kv get -field=key secret/xyte"` (Vault), `--key-command "aws secretsmanager get-secret-value --secret-id xyte --query SecretString --output text"` (AWS Secrets Manager). xyte-cli trims leading and trailing whitespace; the command must exit 0 and print only the key on stdout.
- If `--provider` is omitted, setup probes `xyte-org` first and then `xyte-partner`.
- If `--connectivity never` is used, require `--provider`.
- persisted credentials default to secure OS-native storage: macOS Keychain, Windows DPAPI, Linux Secret Service
- if native storage is unavailable under `auth.secretStoreBackend=auto`, `xyte-cli` warns on `stderr` and falls back to file storage; do not treat that warning alone as command failure
- `xyte-cli config path --output json` reports `secretStoreBackend`, `secretStore`, and `legacySecretStore`; `secretStore` may be a backend identifier such as `xyte-cli`, not only a file path
- `xyte-cli setup status --tenant <tenant-id> --field tenantId`

## Purpose And Trigger Conditions

Use when the request involves any of:
- setup/readiness for Xyte access
- tenant/key-slot management through `config tenant` and `config key`
- endpoint discovery or endpoint invocation through `api`
- deterministic flow orchestration (`xyte-cli flow run`)
- custom flow definition lifecycle (`flow create|edit|share|import`) for agent workflows
- util preprocessing operations (prepare structured files from messy input)
- ops inspection, deep-dive analytics, or report generation
- headless console JSON frame consumption

## Non-Goals

- Do not use this skill for arbitrary product strategy or generic markdown authoring.
- Do not perform writes by default.
- Do not use headless text output; headless is JSON-only.

## Mandatory Safety Rules

- Default to read-only.
- Require explicit user intent before endpoint writes, `util import-tree --apply`, `util move-devices --apply`, `edge claim --apply`, `edge claim-batch --apply`, or `edge ping --apply`.
- Headless console is read-only; never treat frames as mutation execution.
- Util preprocessing is external: AI prepares files, `xyte-cli` remains AI-free.
- For util workflows, always do `xyte-cli util prepare` first.
- After structuring util output files, stop and ask the user what to do next (`dry-run`, `apply`, or stop).
- Never auto-apply and never infer permission to create or update from context.
- In automation, always pass `--tenant <tenant-id>`.
- For `organization.incidents.getIncidents`, prefer explicit integer time bounds (`from=0`, `to=<unix-now>`) to avoid empty responses from null or omitted bounds in some environments.

## Claiming Devices (Mandatory Disambiguation)

When a user says "claim device(s)" without naming the claim path, STOP. Never guess from spreadsheet columns, device model, or prior context. Ask this question verbatim and wait for an answer:

> Which claim path applies?
> 1. Native / direct — the device is on the same network as the platform and you have its serial number, MAC, and cloud id (`organization.devices.claimDevice`).
> 2. Edge — the device sits behind an Xyte Edge proxy and is identified by its IP plus a device model id (`organization.edge.startClaim`).
>
> If you meant Cloud-to-Cloud (C2C) claiming: Cloud-to-Cloud (C2C) claiming is not available via the public Xyte API today. Please claim C2C devices from the End Customer Portal.

Rules:
- Never auto-pick based on whichever columns are present.
- Never invent a C2C endpoint. Repeat the C2C-unsupported sentence above verbatim.
- Once the user answers, follow the matching column of the table below.

| Path | Catalog key | One-off command | Batch command |
| --- | --- | --- | --- |
| Native | `organization.devices.claimDevice` | `xyte-cli api call organization.devices.claimDevice --tenant <tenant-id> --body-json '{"name":"<name>","space_id":<space-id>,"sn":"<sn>","mac":"<mac>","cloud_id":"<cloud-id>"}'` | `xyte-cli util prepare --action organization.devices.claimDevice ...` then call per row |
| Edge | `organization.edge.startClaim` | `xyte-cli edge claim --proxy-id <proxy-id> --device-ip <ip> --device-model-id <model-id> --space-id <space-id> --plan` | `xyte-cli util prepare --action organization.edge.startClaim ...` then `xyte-cli edge claim-batch --input ./prepared/organization-edge-startclaim.csv --plan` |
| C2C | (none — not public) | Point the user at the End Customer Portal | Same |

Edge-claim safety:
- `edge claim`, `edge claim-batch`, and `edge ping` are mutating. Default to `--plan`; only run `--apply` after explicit user approval.
- `edge claim-status` and `edge ping-status` are read-only.
- After `xyte-cli util prepare --action organization.edge.startClaim`, populate the generated `organization-edge-startclaim.csv` before running `edge claim-batch --plan`.
- In `edge claim-batch`, blank or `skip_connectivity_check=false` rows run a pre-claim `edge ping` inside the batch before `startClaim`; `skip_connectivity_check=true` skips that ping.
- `edge claim-batch --skip-connectivity-check` makes blank rows skip ping and send `skip_connectivity_check: true`; explicit row `false` conflicts and is rejected.
- If a batch is interrupted (ctrl-C, network blip), resume with `xyte-cli edge claim-batch --input <primary-csv> --apply --resume-artifact <path>`; never re-run without `--resume-artifact` on a half-finished run.
- The resume artifact records completed row dispositions only; it does not checkpoint in-flight claim IDs. If the CLI exits after `startClaim` but before the row result is written, check `edge claim-status` / logs before rerunning because resume may dispatch `startClaim` again for that row.
- Heartbeat device model id: `5dc4ba6c-c323-4118-a4e4-504f074426f2`. `proxy_id` lives in the End Customer Portal.
- Poll defaults: 5 s interval, 10 min timeout. Override with `--poll-interval-ms` / `--poll-timeout-ms`.

Edge-claim terminal-state decision tree:
- `pending` past timeout → row disposition `timeout` with the last-polled payload; increase `--poll-timeout-ms` for slow claims. Resume retries non-terminal rows.
- `failed` → surface server detail; continue the batch.
- Start returns 422 → row rejected (`rejected` disposition); never poll.
- Start returns 401 → abort the whole batch; remediation is `xyte-cli setup run` or `config key`.
- Duplicate claim (detail mentions "already claimed") → row marked `already-claimed`; batch exits clean if all rows are terminal-success or already-claimed.
- Status returns 422 "not initiated" → first poll tolerates a bounded race; real 422 thereafter is rejection.
- 429 → exponential backoff with jitter; honor `Retry-After`.
- Pre-claim ping rejected/failed/timeout in batch → row marked `ping-failed`; no `startClaim`; resume retries the row.
- Partial batch failure or `proxy-offline` rows → exit code 1 with a per-row audit NDJSON report (`--report`); fix rejects, re-run with the separate `--resume-artifact` path.
- `--plan` over a batch → zero API calls; exit 0 only if every row would succeed.

Full recipes and the 20-row edge-case matrix: `references/claim-playbook.md`.

## Flow Runner First (Agent Context)

For multi-step operations, prefer one deterministic command over hand-built step chains:

- `xyte-cli flow run <flow-id> --tenant <tenant-id> --plan`
- `xyte-cli flow run <flow-id> --tenant <tenant-id> --apply --resume <run-id-or-path>`

Rules:
- default to `--plan`
- only use `--apply` after explicit user approval
- treat flow IDs as agent-facing contracts; users can speak naturally and the agent maps intent to a flow ID
- use `xyte-cli flow list --format text` for human discoverability before proposing a flow
- prefer `nextAction` from `xyte.flow.run.v1` over raw step scanning when a run stops before completion
- parse run summary contract `xyte.flow.run.v1` and return artifact paths plus resume command to users

## Deterministic Execution Order

1. Setup/readiness:
- `xyte-cli status --mode fast --output json`
- `xyte-cli init --scope both --agents all --force --no-setup`
- `xyte-cli setup status --tenant <tenant-id> --output json`
- `xyte-cli config doctor --tenant <tenant-id> --output json`
- `xyte-cli config show --scope resolved`
- `xyte-cli doctor install --format json`
- `xyte-cli doctor environment --format json` (install/setup environment diagnostics with a recommended install mode)

2. Auth/tenant (if missing or incomplete):
- human-guided setup: `xyte-cli setup run --tenant <tenant-id> [--provider <xyte-org|xyte-partner>]`
- automation setup: use `--key-file <path-outside-workspace>` or pipe the key on stdin to `xyte-cli setup run --non-interactive --tenant <tenant-id> [--provider <xyte-org|xyte-partner>] --key-stdin`
- secret-manager setup: use `--key-command "<cmd>"`, e.g. `xyte-cli setup run --non-interactive --tenant <tenant-id> --key-command "op read op://Employee/Xyte/credential"`
- `xyte-cli setup status --tenant <tenant-id> --field tenantId`
- `xyte-cli config tenant use <tenant-id>`
- `xyte-cli config key list --tenant <tenant-id> --output json`

3. Endpoint operations:
- `xyte-cli api endpoints list`
- `xyte-cli api endpoints describe <endpoint-key>`
- `xyte-cli api call <endpoint-key> --tenant <tenant-id> ...`

4. Insights/reports:
- `xyte-cli ops inspect fleet --tenant <tenant-id> --provider-scope auto --output json`
- `xyte-cli ops inspect deep-dive --tenant <tenant-id> --provider-scope auto --window <hours> --output json`
- `xyte-cli ops report generate --tenant <tenant-id> --input <input.json> --out <path> [--render markdown|pdf] [--include-sensitive]`

Provider/report behavior:
- inspect pipelines are scope-strict; no cross-provider calls
- `--provider-scope auto` chooses the only configured scope and fails when both scopes are configured
- partner deep-dive/report enrichment is best-effort; optional enrichment failures should not block report generation

5. Util preprocessing and execution:
- `xyte-cli util list-actions [--output text|json] [--mode friendly|generic] [--execution-support space.import-tree|device.move|edge.claim-batch|prepare-only|call-loop-only]`
- `xyte-cli util prepare --action <action-key> --input <file> [--tenant <tenant-id>] [--output-dir <dir>] [--force]`
- stop and ask for a user decision before any execution command
- `xyte-cli util import-tree --tenant <tenant-id> --input <file> [--input-format auto|csv|json|jsonl] [--apply] [--continue-on-error] [--report <path>]`
- `xyte-cli util match --source <path> --target <path> --source-field <name> --target-field <name> --out <path> [--tenant <tenant-id>]`
- `xyte-cli util move-devices --tenant <tenant-id> --input <file> [--input-format auto|csv|json|jsonl] [--apply] [--continue-on-error] [--report <path>]`
- preprocessing contract: `references/ai-utility-preprocessing.md`

6. Headless snapshots:
- `xyte-cli ops console --headless --screen <screen> --output json --once --tenant <tenant-id>`

## Workflow Selector

| Intent | Primary command |
| --- | --- |
| Deterministic multi-step ops | `xyte-cli flow run <flow-id> --tenant <tenant-id> --plan` |
| First-time onboarding (interactive) | `xyte-cli` |
| Setup interactive | `xyte-cli setup run --tenant <tenant-id> [--provider <xyte-org\|xyte-partner>]` |
| Setup non-interactive | `xyte-cli setup run --non-interactive --tenant <tenant-id> [--provider <xyte-org\|xyte-partner>] --key-file <path-outside-workspace>` or pipe to `--key-stdin` |
| Setup from secret manager | `xyte-cli setup run --non-interactive --tenant <tenant-id> --key-command "op read op://Vault/Item/field"` (works with any CLI that prints the key on stdout: `op`, `vault`, `aws secretsmanager`, `pass`, …) |
| Readiness snapshot | `xyte-cli setup status --tenant <tenant-id> --output json` |
| Tenant ID extraction | `xyte-cli setup status --tenant <tenant-id> --field tenantId` |
| Connectivity diagnostics | `xyte-cli config doctor --tenant <tenant-id> --output json` |
| Read endpoint call + envelope | `xyte-cli api call <endpoint-key> --tenant <tenant-id> --output-mode envelope --strict-json` |
| Write endpoint call | `xyte-cli api call <endpoint-key> --tenant <tenant-id> ...` |
| Fleet summary | `xyte-cli ops inspect fleet --tenant <tenant-id> --output json --out ./artifacts/fleet.json` |
| Deep-dive analytics | `xyte-cli ops inspect deep-dive --tenant <tenant-id> --window <hours> --output json --out ./artifacts/deep-dive.json` |
| PDF report generation | `xyte-cli ops report generate --tenant <tenant-id> --input <deep-dive.json> --out <path>.pdf` |
| Util action catalog | `xyte-cli util list-actions --output text --mode friendly` |
| Util prepare scaffold | `xyte-cli util prepare --action <action-key> --input <file> --output-dir ./prepared` |
| Connector setup normalization | `xyte-cli util prepare --action organization.connectors.prepareSetup --input <file> --output-dir ./prepared` |
| Team access group normalization | `xyte-cli util prepare --action organization.teamAccess.groups --input <file> --output-dir ./prepared` |
| Team access user normalization | `xyte-cli util prepare --action organization.teamAccess.users --input <file> --output-dir ./prepared` |
| Team access membership normalization | `xyte-cli util prepare --action organization.teamAccess.memberships --input <file> --output-dir ./prepared` |
| Space tree import | `xyte-cli util import-tree --tenant <tenant-id> --input <file> [--apply]` |
| Device-to-space matching | `xyte-cli util match --source <path> --target <path> --source-field <name> --target-field <name> --out <path>` |
| Batch device move | `xyte-cli util move-devices --tenant <tenant-id> --input <file> [--apply]` |
| Claim one edge device | `xyte-cli edge claim --tenant <tenant-id> --proxy-id <proxy-id> --device-ip <ip> --device-model-id <model-id> --space-id <space-id> --plan` |
| Bulk claim edge devices | `xyte-cli util prepare --action organization.edge.startClaim --input <file> --output-dir ./prepared` then `xyte-cli edge claim-batch --tenant <tenant-id> --input ./prepared/organization-edge-startclaim.csv --plan [--skip-connectivity-check]` |
| Edge claim status | `xyte-cli edge claim-status --tenant <tenant-id> --proxy-id <proxy-id> --device-ip <ip>` |
| Edge connectivity probe | `xyte-cli edge ping --tenant <tenant-id> --proxy-id <proxy-id> --device-ip <ip> --plan` |
| Edge ping status | `xyte-cli edge ping-status --tenant <tenant-id> --proxy-id <proxy-id> --device-ip <ip>` |
| Install diagnostics | `xyte-cli doctor install --format json` |
| Environment diagnostics | `xyte-cli doctor environment --format json` (add `--check-network` to probe npm registry reachability) |
| Settings introspection | `xyte-cli config show --scope resolved` |
| Interactive console | `xyte-cli ops console` |
| Headless snapshot | `xyte-cli ops console --headless --screen <screen> --output json --once --tenant <tenant-id>` |
| Continuous headless monitoring | `xyte-cli ops console --headless --screen <screen> --output json --follow --interval-ms <ms> --tenant <tenant-id>` |

## Flow Selector (Deterministic)

Use this selector when the user asks for repeatable operator workflows. Full recipes: `references/flow-recipes.md`.

| Intent | Flow ID | First command |
| --- | --- | --- |
| Readiness check in a new or stale environment | `flow.setup-readiness-10m` | `xyte-cli status --mode fast --output json` |
| Continuous incident monitoring | `flow.incidents-delta-watch` | `xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --output json --strict-json` |
| Convert watch deltas into triage artifacts | `flow.watch-to-triage` | `xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --output json --strict-json` |
| Operator-approved remediation writes | `flow.guided-remediation` | `xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --output json --strict-json` |
| Deterministic device migration with human gates | `flow.device-migration` | `xyte-cli api call organization.devices.getDevices --tenant <tenant-id> --query space_id=<source-space-id>` |
| Daily analytics summary and report artifact | `flow.daily-deep-dive-report` | `xyte-cli setup status --tenant <tenant-id> --output json` |
| Claim a single edge device end-to-end | `flow.edge-claim` | `xyte-cli flow run flow.edge-claim --tenant <tenant-id> --plan --var proxy_id=<proxy-id> --var device_ip=<ip> --var device_model_id=<model-id> --var space_id=<space-id>` |
| Bulk claim edge devices (plan/apply with resume) | `flow.edge-claim-batch` | `xyte-cli flow run flow.edge-claim-batch --tenant <tenant-id> --plan --var edge_claim_input_path=<file>` |
| Edge connectivity probe | `flow.edge-ping` | `xyte-cli flow run flow.edge-ping --tenant <tenant-id> --plan --var proxy_id=<proxy-id> --var device_ip=<ip>` |

## Agent-Only Flow Authoring

Use this when a user asks for a new flow tailored to their workflow:

1. Ask for:
- intent/outcome
- base built-in flow (`xyte-cli flow list`)
- required default context values (`device_id`, `ticket_id`, `incident_id`, etc.)
- whether they want an exported share file

2. Create or edit:

```bash
xyte-cli flow create <custom-flow-id> --based-on <built-in-flow-id> --title "<title>" --description "<description>" --var key=value
xyte-cli flow edit <custom-flow-id> --var key=value
```

3. Share/import when requested:

```bash
xyte-cli flow share <custom-flow-id> --out <path>
xyte-cli flow import --file <path>
```

4. Validate with a safe dry run:

```bash
xyte-cli flow run <custom-flow-id> --tenant <tenant-id> --plan
```

## Minimal Command Recipes

Read call:

```bash
xyte-cli api call organization.devices.getDevices --tenant <tenant-id> --output-mode envelope --strict-json
```

Incident read call (reliable time window; replace `1710000000` with the current Unix timestamp in your shell or runtime):

```bash
xyte-cli api call organization.incidents.getIncidents \
  --tenant <tenant-id> \
  --query-json '{"status":"active","from":0,"to":1710000000,"page":1,"per_page":100}'
```

Write call:

```bash
xyte-cli api call organization.commands.getCommands \
  --tenant <tenant-id> \
  --path-json '{"device_id":"<device-id>"}' \
  --query-json '{"page":1,"per_page":20}'

xyte-cli api call organization.commands.sendCommand \
  --tenant <tenant-id> \
  --path-json '{"device_id":"<device-id>"}' \
  --body-json '{"command":"<valid-command-from-history>"}'
```

Delete call:

```bash
xyte-cli api call organization.commands.cancelCommand \
  --tenant <tenant-id> \
  --path-json '{"device_id":"<device-id>","command_id":"<command-id>"}'
```

Headless:

```bash
xyte-cli ops console --headless --screen dashboard --output json --once --tenant <tenant-id>
```

Interactive console:

```bash
xyte-cli ops console
```

Inspect + report:

```bash
xyte-cli ops inspect deep-dive --tenant <tenant-id> --window 24 --output json --out ./artifacts/deep-dive.json
xyte-cli ops report generate --tenant <tenant-id> --input ./artifacts/deep-dive.json --out ./artifacts/xyte-findings.pdf
```

Util prepare then execute:

```bash
xyte-cli util list-actions --output text --mode friendly
xyte-cli util prepare --action organization.devices.claimDevice --input ./raw-source.xlsx --tenant <tenant-id> --output-dir ./prepared

xyte-cli api call organization.spaces.getSpace --tenant <tenant-id> --path-json '{"space_id":"<space-id>"}'
xyte-cli api call organization.devices.claimDevice --tenant <tenant-id> --output-mode envelope --body-json '{"name":"<name>","space_id":<space-id>,"sn":"<sn>","mac":"<mac>","cloud_id":"<cloud-id>"}'

xyte-cli util prepare --action space.import-tree --input ./raw-tree.pdf --tenant <tenant-id> --output-dir ./prepared
xyte-cli util import-tree --tenant <tenant-id> --input ./prepared/space-import-tree.csv
xyte-cli util import-tree --tenant <tenant-id> --input ./prepared/space-import-tree.csv --apply --report ./artifacts/space-import-report.ndjson
```

Action log lookup:

```bash
xyte-cli logs list --session-id <session-id> --output text
xyte-cli logs show --entry <session-id>:<seq> --output json
xyte-cli logs show --request-id <request-id> --output json
```

AI preprocessing prompt templates:

```bash
cat templates/ai-utility-prepare-generic.prompt.md
cat templates/ai-space-import.prompt.md
```

## Contract IDs And Schemas

Schema/version IDs:
- call envelope: `xyte.call.envelope.v1`
- device match: `xyte.device.match.v1`
- device move verification: `xyte.device.move-verification.v1`
- flow catalog: `xyte.flow.catalog.v1`
- flow definition: `xyte.flow.definition.v1`
- flow run summary: `xyte.flow.run.v1`
- headless frame: `xyte.headless.frame.v1`
- inspect fleet: `xyte.inspect.fleet.v1`
- inspect deep dive: `xyte.inspect.deep-dive.v1`
- report metadata: `xyte.report.v1`
- status: `xyte.status.v1`
- upgrade check: `xyte.upgrade.check.v1`
- upgrade result: `xyte.upgrade.result.v1`
- utility batch summary: `xyte.utility.batch.v1`
- utility prepare: `xyte.utility.prepare.v1`
- watch frame: `xyte.watch.frame.v1`

Canonical schemas:
- `schemas/call-envelope.v1.schema.json`
- `schemas/headless-frame.v1.schema.json`
- `schemas/inspect-fleet.v1.schema.json`
- `schemas/inspect-deep-dive.v1.schema.json`
- `schemas/report.v1.schema.json`
- `schemas/utility-batch.v1.schema.json`
- `schemas/utility-prepare.v1.schema.json`

## Troubleshooting Entrypoints

- First-run/setup issues:
  - `xyte-cli`
  - `xyte-cli setup run --tenant <tenant-id> [--provider <xyte-org|xyte-partner>]`
  - for automation, use `--key-file <path-outside-workspace>` or pipe the key on stdin to `xyte-cli setup run --non-interactive --tenant <tenant-id> [--provider <xyte-org|xyte-partner>] --key-stdin`
  - for secret managers, use `--key-command "<cmd>"`, e.g. `--key-command "op read op://Employee/Xyte/credential"` — xyte-cli runs the command and uses its stdout as the key
- Install wiring diagnostics:
  - `xyte-cli doctor install --format json`
- Readiness/connectivity:
  - `xyte-cli setup status --tenant <tenant-id> --output json`
  - `xyte-cli setup status --tenant <tenant-id> --field tenantId`
  - `xyte-cli config doctor --tenant <tenant-id> --output json`
  - `xyte-cli config show --scope resolved`
- Console crash diagnostics:

```bash
xyte-cli ops console --tenant <tenant-id>
```

- Headless errors:
  - ensure `--headless --output json`
  - parse NDJSON and use the last runtime frame (`meta.startup != true`)

## References (Load As Needed)

- `references/ai-utility-preprocessing.md`
- `references/claim-playbook.md`
- `references/endpoints.md`
- `references/utilities.md`
- `references/utility-ai-space-import-tree.md`
- `references/flow-recipes.md`
- `references/tui-flows.md`
- `references/headless-contract.md`

## Notes For Agents

- Keep this file short in-context; use references for deep procedures.
- Keep tenant explicit in automation (`--tenant <tenant-id>`).
