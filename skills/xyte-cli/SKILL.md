---
name: xyte-cli
description: "Use for @xyteai/cli operations: first-run setup, config/tenant/key management, api endpoint calls, ops inspection/reporting, util preprocessing/import-tree execution, and JSON-only headless console snapshots."
---

# XYTE Skill Router (One-Stop, Agent-Native)

Last updated: 2026-04-15

This skill is the entrypoint for deterministic Xyte operations via `xyte-cli`.

## Invocation Rules

- Use `xyte-cli` commands directly.
- Do not use source/dev entrypoints (`tsx`, `src/*`, `dist/*`, `bin/*`).
- If `xyte-cli` is unavailable on `PATH`, use `npx @xyteai/cli@latest <command>` or `npm exec -- @xyteai/cli@latest <command>` until `PATH` is fixed.
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
- for automation: use `--key-file <path>` or pipe the key on stdin to `xyte-cli setup run --non-interactive --tenant <tenant-id> [--provider <xyte-org|xyte-partner>] --key-stdin`
- If `--provider` is omitted, setup probes `xyte-org` first and then `xyte-partner`.
- If `--connectivity never` is used, require `--provider`.
- persisted credentials default to secure OS-native storage: macOS Keychain, Windows DPAPI, Linux Secret Service
- if native storage is unavailable under `auth.secretStoreBackend=auto`, `xyte-cli` warns on `stderr` and falls back to file storage; do not treat that warning alone as command failure
- `xyte-cli config path --format json` reports `secretStoreBackend`, `secretStore`, and `legacySecretStore`; `secretStore` may be a backend identifier such as `xyte-cli`, not only a file path
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
- Require explicit user intent before endpoint writes, `util import-tree --apply`, or `util move-devices --apply`.
- Headless console is read-only; never treat frames as mutation execution.
- Util preprocessing is external: AI prepares files, `xyte-cli` remains AI-free.
- For util workflows, always do `xyte-cli util prepare` first.
- After structuring util output files, stop and ask the user what to do next (`dry-run`, `apply`, or stop).
- Never auto-apply and never infer permission to create or update from context.
- In automation, always pass `--tenant <tenant-id>`.
- For `organization.incidents.getIncidents`, prefer explicit integer time bounds (`from=0`, `to=<unix-now>`) to avoid empty responses from null or omitted bounds in some environments.

## Flow Runner First (Agent Context)

For multi-step operations, prefer one deterministic command over hand-built step chains:

- `xyte-cli flow run <flow-id> --tenant <tenant-id> --plan`
- `xyte-cli flow run <flow-id> --tenant <tenant-id> --apply --resume <run-id-or-path>`

Rules:
- default to `--plan`
- only use `--apply` after explicit user approval
- treat flow IDs as agent-facing contracts; users can speak naturally and the agent maps intent to a flow ID
- use `xyte-cli flow list` for discoverability before proposing a flow
- parse run summary contract `xyte.flow.run.v1` and return artifact paths plus resume command to users

## Deterministic Execution Order

1. Setup/readiness:
- `xyte-cli status --mode fast --output json`
- `xyte-cli init --scope both --agents all --force --no-setup`
- `xyte-cli setup status --tenant <tenant-id> --output json`
- `xyte-cli config doctor --tenant <tenant-id> --output json`
- `xyte-cli config show --scope resolved`
- `xyte-cli doctor install --format json`

2. Auth/tenant (if missing or incomplete):
- human-guided setup: `xyte-cli setup run --tenant <tenant-id> [--provider <xyte-org|xyte-partner>]`
- automation setup: use `--key-file <path>` or pipe the key on stdin to `xyte-cli setup run --non-interactive --tenant <tenant-id> [--provider <xyte-org|xyte-partner>] --key-stdin`
- `xyte-cli setup status --tenant <tenant-id> --field tenantId`
- `xyte-cli config tenant use <tenant-id>`
- `xyte-cli config key list --tenant <tenant-id> --output json`

3. Endpoint operations:
- `xyte-cli api endpoints list`
- `xyte-cli api endpoints describe <endpoint-key>`
- `xyte-cli api call <endpoint-key> --tenant <tenant-id> ...`

4. Insights/reports:
- `xyte-cli ops inspect fleet --tenant <tenant-id> --provider-scope auto --render json|ascii`
- `xyte-cli ops inspect deep-dive --tenant <tenant-id> --provider-scope auto --window <hours> --render json|ascii|markdown`
- `xyte-cli ops report generate --tenant <tenant-id> --input <input.json> --out <path> [--render markdown|pdf] [--include-sensitive]`

Provider/report behavior:
- inspect pipelines are scope-strict; no cross-provider calls
- `--provider-scope auto` chooses the only configured scope and fails when both scopes are configured
- partner deep-dive/report enrichment is best-effort; optional enrichment failures should not block report generation

5. Util preprocessing and execution:
- `xyte-cli util list-actions [--output text|json]`
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
| Setup non-interactive | `xyte-cli setup run --non-interactive --tenant <tenant-id> [--provider <xyte-org\|xyte-partner>] --key-file <path>` or pipe to `--key-stdin` |
| Readiness snapshot | `xyte-cli setup status --tenant <tenant-id> --output json` |
| Tenant ID extraction | `xyte-cli setup status --tenant <tenant-id> --field tenantId` |
| Connectivity diagnostics | `xyte-cli config doctor --tenant <tenant-id> --output json` |
| Read endpoint call + envelope | `xyte-cli api call <endpoint-key> --tenant <tenant-id> --output-mode envelope --strict-json` |
| Write endpoint call | `xyte-cli api call <endpoint-key> --tenant <tenant-id> ...` |
| Fleet summary | `xyte-cli ops inspect fleet --tenant <tenant-id> --output json --out ./artifacts/fleet.json` |
| Deep-dive analytics | `xyte-cli ops inspect deep-dive --tenant <tenant-id> --window <hours> --output json --out ./artifacts/deep-dive.json` |
| PDF report generation | `xyte-cli ops report generate --tenant <tenant-id> --input <deep-dive.json> --out <path>.pdf` |
| Util action catalog | `xyte-cli util list-actions --output text` |
| Util prepare scaffold | `xyte-cli util prepare --action <action-key> --input <file> --output-dir ./prepared` |
| Space tree import | `xyte-cli util import-tree --tenant <tenant-id> --input <file> [--apply]` |
| Device-to-space matching | `xyte-cli util match --source <path> --target <path> --source-field <name> --target-field <name> --out <path>` |
| Batch device move | `xyte-cli util move-devices --tenant <tenant-id> --input <file> [--apply]` |
| Install diagnostics | `xyte-cli doctor install --format json` |
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
xyte-cli util list-actions --output text
xyte-cli util prepare --action organization.devices.claimDevice --input ./raw-source.xlsx --tenant <tenant-id> --output-dir ./prepared

xyte-cli api call organization.spaces.getSpace --tenant <tenant-id> --path-json '{"space_id":"<space-id>"}'
xyte-cli api call organization.devices.claimDevice --tenant <tenant-id> --output-mode envelope --body-json '{"name":"<name>","space_id":<space-id>,"sn":"<sn>","mac":"<mac>","cloud_id":"<cloud-id>"}'

xyte-cli util prepare --action space.import-tree --input ./raw-tree.pdf --tenant <tenant-id> --output-dir ./prepared
xyte-cli util import-tree --tenant <tenant-id> --input ./prepared/space-import-tree.csv
xyte-cli util import-tree --tenant <tenant-id> --input ./prepared/space-import-tree.csv --apply --report ./artifacts/space-import-report.ndjson
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
  - for automation, use `--key-file <path>` or pipe the key on stdin to `xyte-cli setup run --non-interactive --tenant <tenant-id> [--provider <xyte-org|xyte-partner>] --key-stdin`
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
- `references/endpoints.md`
- `references/utilities.md`
- `references/utility-ai-space-import-tree.md`
- `references/flow-recipes.md`
- `references/tui-flows.md`
- `references/headless-contract.md`

## Notes For Agents

- Keep this file short in-context; use references for deep procedures.
- Keep tenant explicit in automation (`--tenant <tenant-id>`).
