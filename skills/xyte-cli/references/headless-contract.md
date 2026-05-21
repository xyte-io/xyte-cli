# Headless JSON Contract

This contract is for agent parsers consuming:

```bash
xyte-cli ops console --headless --screen <screen> --output json --once --tenant <tenant-id>
```

## Frame Model

Each line is one JSON frame.

Required top-level fields:
- `schemaVersion` (`"xyte.headless.frame.v1"`)
- `timestamp` (ISO string)
- `sessionId` (stable per run)
- `sequence` (monotonic per run)
- `mode` (`"headless"`)
- `screen` (screen id)
- `title` (string)
- `status` (string)
- `tenantId` (string or omitted)
- `motionEnabled` (boolean)
- `motionPhase` (number)
- `logo` (string)
- `panels` (array)
- `meta` (object)

## Startup Vs Runtime Frames

Startup frames:
- `meta.startup == true`
- typically no operational panels

Runtime frame selection rule:
- parse the last frame where `meta.startup` is missing or `false`

## Required `meta` Keys (Runtime)

- `inputState`: `idle | modal | busy`
- `queueDepth`: number
- `droppedEvents`: number
- `transitionState`: `idle | switching`
- `refreshState`: `idle | loading | retrying | error`
- `navigationMode`: `pane-focus`
- `activePane`: string
- `availablePanes`: string[]
- `tabId`: screen id
- `tabOrder`: screen id[]
- `tabNavBoundary`: `left | right | null`
- `renderSafety`: `ok | truncated`
- `tableFormat`: `compact-v1`
- `contract.frameVersion`: `xyte.headless.frame.v1`
- `contract.tableFormat`: `compact-v1`
- `contract.navigationMode`: `pane-focus`

Runtime write-safety keys (always present on operational frames):
- `writePolicy`: `organization-only`
- `headlessWrite`: `false`
- `actionsHint`: screen-specific hint string (human-readable, not agent-parseable)

Common optional keys:
- `readiness`
- `connection`
- `retry`
- `blocking`
- `redirectedFrom`

## Setup Gate Rule

If an operational screen is blocked by readiness:
- emitted `screen` is `setup`
- `meta.redirectedFrom` contains the requested screen

Agent behavior:
1. detect redirect
2. run setup/config remediation via CLI
3. retry the original requested screen

## Panel Parsing

Panel fields:
- `id`
- `title`
- `kind`: `stats | table | text`
- optional `status`

By kind:
- `stats`: parse `stats[]` items `{label, value}`
- `table`: parse `table.columns[]` and `table.rows[][]`
- `text`: parse `text.lines[]`

## Render Safety Guidance

- `meta.renderSafety == "truncated"` means payload preview was safely truncated.
- Do not assume full raw object data is present in text panels.
- Use direct CLI endpoint calls when complete raw payload is required.

## JSON Schema

- Schema file: `schemas/headless-frame.v1.schema.json`
