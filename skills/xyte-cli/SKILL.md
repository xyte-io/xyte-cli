---
name: xyte-cli
description: "Use for @xyteai/cli operations: first-run setup, tenant/key auth, guarded endpoint calls, utility preprocessing + import-tree execution, inspect/report generation, and JSON-only headless TUI snapshots with schema-validated outputs."
---

# XYTE Skill Router (One-Stop, Agent-Native)

Last updated: 2026-02-25

This skill is the entrypoint for deterministic Xyte operations via `xyte-cli`.

## Invocation Rules

- Use `xyte-cli` commands directly.
- Do not use source/dev entrypoints (`npx`, `tsx`, `src/*`, `dist/*`, `bin/*`).
- If `xyte-cli` is unavailable, ask the user to install `@xyteai/cli` globally instead of improvising an entrypoint.
- Command option correctness:
  - `xyte-cli tenant list` has no `--format`.
  - `xyte-cli setup status` supports `--format json|text`.
- For fresh users in a new environment, verify readiness with:
  - `xyte-cli doctor install --format json`
  - `xyte-cli install --skills --scope both --agents all --force` (or the agent-specific install target)
  - `xyte-cli setup run --non-interactive --tenant <tenant-id> --key <value>`

## Purpose and Trigger Conditions

Use when the request involves any of:
- setup/readiness for Xyte access
- tenant/key-slot management
- endpoint discovery or endpoint invocation
- deterministic flow orchestration (`xyte-cli flow run`)
- custom flow definition lifecycle (`flow create|edit|share|import`) for agent workflows
- utility preprocessing operations (prepare structured files from messy input)
- fleet inspection/deep-dive/reporting
- headless TUI JSON frame consumption

## Non-Goals

- Do not use this skill for arbitrary product strategy or generic markdown authoring.
- Do not perform writes by default.
- Do not use headless text output; headless is JSON-only.

## Mandatory Safety Rules

- Default to read-only.
- Require explicit user intent before writes.
- Non-read endpoint calls must include `--allow-write`.
- Destructive endpoint calls must include `--confirm <endpoint-key>`.
- TUI interactive write actions are organization-only in ops screens.
- Headless TUI is read-only; never treat headless frames as mutation execution.
- Utility preprocessing is external: AI prepares files, `xyte-cli` remains AI-free.
- For utility workflows: always do `utility prepare` first.
- Hard decision gate: after structuring output files, stop and ask the user what to do next (`dry-run`, `apply`, or stop).
- Never run `space import-tree` until the user explicitly chooses the next action.
- Never auto-apply and never infer permission to create/update from context.
- In automation, always pass `--tenant <tenant-id>`.
- For `organization.incidents.getIncidents`, prefer explicit integer time bounds (`from=0`, `to=<unix-now>`) to avoid empty responses from null/omitted bounds in some environments.

## Flow Runner First (Agent Context)

For multi-step operations, prefer one deterministic command over hand-built step chains:

- `xyte-cli flow run <flow-id> --tenant <tenant-id> --plan`
- `xyte-cli flow run <flow-id> --tenant <tenant-id> --apply --allow-write --resume <run-id-or-path>`

Rules:
- default to `--plan`.
- only use `--apply` after explicit user approval.
- treat flow IDs as agent-facing contracts; users can speak naturally and the agent maps intent -> flow ID.
- use `xyte-cli flow list` for discoverability before proposing a flow.
- parse run summary contract `xyte.flow.run.v1` and return artifact paths/resume command to users.

## Deterministic Execution Order

0. Preferred multi-step execution:
- `xyte-cli flow list`
- `xyte-cli flow run <flow-id> --tenant <tenant-id> --plan`
- `xyte-cli flow run <flow-id> --tenant <tenant-id> --apply --allow-write --resume <run-id-or-path>`

1. Setup/readiness:
- `xyte-cli doctor install --format json`
- `xyte-cli install --skills --scope both --agents all --force --no-setup`
- `xyte-cli setup status --tenant <tenant-id> --format json`
- `xyte-cli config doctor --tenant <tenant-id> --format json`

2. Auth/tenant (if missing/incomplete):
- `xyte-cli setup run --non-interactive --tenant <tenant-id> --key <value>`
- `xyte-cli tenant use <tenant-id>`
- `xyte-cli auth key list --tenant <tenant-id> --format json`

3. Endpoint operations:
- `xyte-cli list-endpoints --tenant <tenant-id>`
- `xyte-cli describe-endpoint <endpoint-key>`
- `xyte-cli call <endpoint-key> --tenant <tenant-id> ...`

4. Insights/reports:
- `xyte-cli inspect fleet --tenant <tenant-id> --format json`
- `xyte-cli inspect deep-dive --tenant <tenant-id> --window <hours> --format json`
- `xyte-cli report generate --tenant <tenant-id> --input <deep-dive.json> --out <report.pdf>`

5. Utility preprocessing (agent parses file, CLI scaffolds contract):
- `xyte-cli utility list-actions [--format text|json]`
- `xyte-cli utility prepare --action <action-key> --input <file> [--tenant <tenant-id>] [--output-dir <dir>]`
- Stop and ask user decision before any execution command.
- `xyte-cli space import-tree --tenant <tenant-id> --input <file> [--apply]`
- preprocessing contract: `/Users/porton/Projects/xyte-cli/docs/ai-utility-preprocessing.md`
- decision gate: after structuring files, ask user what to do next; do not assume apply.

6. Headless snapshots:
- `xyte-cli tui --headless --screen <screen> --format json --once --tenant <tenant-id>`

## Workflow Selector

| Intent | Primary command |
| --- | --- |
| Deterministic multi-step ops | `xyte-cli flow run <flow-id> --tenant <tenant-id> --plan` |
| First-time onboarding (interactive) | `xyte-cli` |
| Setup non-interactive | `xyte-cli setup run --non-interactive --tenant <tenant-id> --key <value>` |
| Readiness snapshot | `xyte-cli setup status --tenant <tenant-id> --format json` |
| Connectivity diagnostics | `xyte-cli config doctor --tenant <tenant-id> --format json` |
| Read endpoint call + envelope | `xyte-cli call <endpoint-key> --tenant <tenant-id> --output-mode envelope --strict-json` |
| Guarded write endpoint call | `xyte-cli call <endpoint-key> --tenant <tenant-id> --allow-write ...` |
| Guarded delete endpoint call | `xyte-cli call <endpoint-key> --tenant <tenant-id> --allow-write --confirm <endpoint-key> ...` |
| Fleet summary | `xyte-cli inspect fleet --tenant <tenant-id> --format json` |
| Deep-dive analytics | `xyte-cli inspect deep-dive --tenant <tenant-id> --window <hours> --format json` |
| PDF report generation | `xyte-cli report generate --tenant <tenant-id> --input <deep-dive.json> --out <path>.pdf` |
| Utility action catalog | `xyte-cli utility list-actions --format text` |
| Utility prepare scaffold | `xyte-cli utility prepare --action <action-key> --input <file> --output-dir ./tmp` |
| Space tree import | `xyte-cli space import-tree --tenant <tenant-id> --input <file> [--apply]` |
| TUI interactive ops | `xyte-cli tui` then use `a` (actions), `f` (filters), `[`/`]` (pages), `p` (per-page) |
| Headless snapshot (JSON NDJSON) | `xyte-cli tui --headless --screen <screen> --format json --once --tenant <tenant-id>` |
| Continuous headless monitoring | `xyte-cli tui --headless --screen <screen> --format json --follow --interval-ms <ms> --tenant <tenant-id>` |

## Flow Selector (Deterministic)

Use this selector when the user asks for repeatable operator workflows. Full recipes: `references/flow-recipes.md`.

| Intent | Flow ID | First command |
| --- | --- | --- |
| Readiness check in a new or stale environment | `flow.setup-readiness-10m` | `xyte-cli doctor install --format json` |
| Continuous incident monitoring | `flow.incidents-delta-watch` | `xyte-cli watch --tenant <tenant-id> --profile incidents-active --once --strict-json` |
| Convert watch deltas into triage artifacts | `flow.watch-to-triage` | `xyte-cli watch --tenant <tenant-id> --profile incidents-active --once --strict-json` |
| Operator-approved remediation writes | `flow.guided-remediation` | `xyte-cli watch --tenant <tenant-id> --profile incidents-active --once --strict-json` |
| Bulk claim preprocessing + space import execution | `flow.bulk-claim-and-space-import` | `xyte-cli utility prepare --action organization.devices.claimDevice --tenant <tenant-id> --input ./claims-source.csv --output-dir ./tmp/flow-bulk-claim` |
| Daily analytics summary and report artifact | `flow.daily-deep-dive-report` | `xyte-cli setup status --tenant <tenant-id> --format json` |

## Agent-Only Flow Authoring

Use this when a user asks for a new flow tailored to their workflow:

1. Ask for:
- intent/outcome
- base built-in flow (`flow list`)
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
xyte-cli call organization.devices.getDevices --tenant <tenant-id> --output-mode envelope --strict-json
```

Incident read call (reliable time window):
```bash
NOW=$(date +%s)
xyte-cli call organization.incidents.getIncidents --tenant <tenant-id> --query-json "{\"status\":\"active\",\"from\":0,\"to\":$NOW,\"page\":1,\"per_page\":100}"
```

Write call (guarded):
```bash
xyte-cli call organization.commands.getCommands \
  --tenant <tenant-id> \
  --path-json '{"device_id":"<device-id>"}' \
  --query-json '{"page":1,"per_page":20}'

xyte-cli call organization.commands.sendCommand \
  --tenant <tenant-id> \
  --allow-write \
  --path-json '{"device_id":"<device-id>"}' \
  --body-json '{"command":"<valid-command-from-history>"}'
```

Delete call (guarded):
```bash
xyte-cli call organization.commands.cancelCommand \
  --tenant <tenant-id> \
  --allow-write \
  --confirm organization.commands.cancelCommand \
  --path-json '{"device_id":"<device-id>","command_id":"<command-id>"}'
```

Headless:
```bash
xyte-cli tui --headless --screen dashboard --format json --once --tenant <tenant-id>
```

Interactive TUI write actions:
```bash
xyte-cli tui
# In ops screens: a actions, f filters, [ ] pages, p per-page
```

Inspect + report:
```bash
xyte-cli inspect deep-dive --tenant <tenant-id> --window 24 --format json > /tmp/deep-dive.json
xyte-cli report generate --tenant <tenant-id> --input /tmp/deep-dive.json --out /tmp/xyte-findings.pdf
```

Utility prepare then execute:
```bash
xyte-cli utility list-actions --format text
xyte-cli utility prepare --action organization.devices.claimDevice --input ./raw-source.xlsx --tenant <tenant-id> --output-dir ./tmp

xyte-cli call organization.spaces.getSpace --tenant <tenant-id> --path-json '{"space_id":"<space-id>"}'
xyte-cli call organization.devices.claimDevice --tenant <tenant-id> --allow-write --output-mode envelope --body-json '{"name":"<name>","space_id":<space-id>,"sn":"<sn>","mac":"<mac>","cloud_id":"<cloud-id>"}'

xyte-cli utility prepare --action space.import-tree --input ./raw-tree.pdf --tenant <tenant-id> --output-dir ./tmp
xyte-cli space import-tree --tenant <tenant-id> --input ./space-import-tree.csv
xyte-cli space import-tree --tenant <tenant-id> --input ./space-import-tree.csv --apply --report ./space-import-report.ndjson
```

AI preprocessing prompt templates:
```bash
cat /Users/porton/Projects/xyte-cli/scripts/templates/ai-utility-prepare-generic.prompt.md
cat /Users/porton/Projects/xyte-cli/scripts/templates/ai-space-import.prompt.md
```

## Contract IDs and Schemas

Schema/version IDs:
- call envelope: `xyte.call.envelope.v1`
- headless frame: `xyte.headless.frame.v1`
- inspect fleet: `xyte.inspect.fleet.v1`
- inspect deep dive: `xyte.inspect.deep-dive.v1`
- report metadata: `xyte.report.v1`
- utility batch summary: `xyte.utility.batch.v1`
- utility prepare: `xyte.utility.prepare.v1`

Canonical schemas:
- `docs/schemas/call-envelope.v1.schema.json`
- `docs/schemas/headless-frame.v1.schema.json`
- `docs/schemas/inspect-fleet.v1.schema.json`
- `docs/schemas/inspect-deep-dive.v1.schema.json`
- `docs/schemas/report.v1.schema.json`
- `docs/schemas/utility-batch.v1.schema.json`
- `docs/schemas/utility-prepare.v1.schema.json`

## Troubleshooting Entrypoints

- First-run/setup issues:
  - `xyte-cli`
  - `xyte-cli setup run --non-interactive --tenant <tenant-id> --key <value>`
- Readiness/connectivity:
  - `xyte-cli setup status --tenant <tenant-id> --format json`
  - `xyte-cli config doctor --tenant <tenant-id> --format json`
- TUI crash diagnostics:
```bash
XYTE_TUI_DEBUG=1 XYTE_TUI_DEBUG_LOG=/tmp/xyte-tui-debug.log xyte-cli tui --tenant <tenant-id>
```
- Headless errors:
  - ensure `--headless --format json` (no text format in headless)
  - parse NDJSON and use the last runtime frame (`meta.startup != true`)
- Local utility sandbox:
```bash
npm run mock:xyte:local -- --port 3001
npm run smoke:local:utilities -- --base-url http://127.0.0.1:3001 --tenant local
```

## References (Load As Needed)

- `references/endpoints.md`
- `references/utilities.md`
- `references/utility-ai-space-import-tree.md`
- `references/flow-recipes.md`
- `references/tui-flows.md`
- `references/headless-contract.md`

## Notes for Agents

- Keep this file short in-context; use references for deep procedures.
- Keep tenant explicit in automation (`--tenant <tenant-id>`).
