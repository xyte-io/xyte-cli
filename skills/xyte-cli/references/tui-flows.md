# Headless Flows (Agent-First)

Use `xyte-cli tui --headless` as the visual/tooling interface for agents.

## Base Pattern

```bash
xyte-cli tui --headless --screen <screen> --format json --once --tenant <tenant-id>
```

Supported screens:
- `setup`
- `config`
- `dashboard`
- `spaces`
- `devices`
- `incidents`
- `tickets`
- `copilot`

## Deterministic Branching (Required)

1. Request operational screen (for example `dashboard`).
2. Parse last non-startup frame.
3. If `frame.screen == "setup"` and `frame.meta.redirectedFrom` is set:
- treat tenant/keys/setup as blocking
- switch to setup/config remediation flow
4. Retry requested operational screen after remediation.

## Setup/Config Remediation Flow

1. Check readiness frame:
```bash
xyte-cli tui --headless --screen setup --format json --once --tenant <tenant-id>
```

2. If missing auth, run CLI key-slot operations:
```bash
xyte-cli auth key add --tenant <tenant-id> --provider xyte-org --name primary --key <value> --set-active
xyte-cli auth key list --tenant <tenant-id> --format json
xyte-cli config doctor --tenant <tenant-id> --format json
```

3. Re-request operational headless frame.

## Per-Screen Headless Recipes

Setup:
```bash
xyte-cli tui --headless --screen setup --format json --once --tenant <tenant-id>
```

Config:
```bash
xyte-cli tui --headless --screen config --format json --once --tenant <tenant-id>
```

Dashboard:
```bash
xyte-cli tui --headless --screen dashboard --format json --once --tenant <tenant-id>
```

Spaces:
```bash
xyte-cli tui --headless --screen spaces --format json --once --tenant <tenant-id>
```

Devices:
```bash
xyte-cli tui --headless --screen devices --format json --once --tenant <tenant-id>
```

Incidents:
```bash
xyte-cli tui --headless --screen incidents --format json --once --tenant <tenant-id>
```

Tickets:
```bash
xyte-cli tui --headless --screen tickets --format json --once --tenant <tenant-id>
```

Copilot snapshot:
```bash
xyte-cli tui --headless --screen copilot --format json --once --tenant <tenant-id>
```

## Follow Mode (Streaming)

```bash
xyte-cli tui --headless --screen spaces --format json --follow --interval-ms 2000 --tenant <tenant-id>
```

Use `--follow` only when continuous status is needed.

## Metadata Keys Agents Should Parse

From top-level frame:
- `schemaVersion` (expect `xyte.headless.frame.v1`)
- `sessionId` (stable for one run)
- `sequence` (monotonic ordering key in `--follow`)

From `frame.meta`:
- `readiness`
- `connection`
- `refreshState`
- `renderSafety`
- `tableFormat`
- `activePane`
- `availablePanes`
- `navigationMode`
- `tabId`
- `tabOrder`
- `tabNavBoundary`
- `redirectedFrom` (when setup gate blocks)
- `contract.frameVersion`
- `contract.tableFormat`
- `contract.navigationMode`

## Output Mode

Headless is JSON-only. Always parse NDJSON frames:
```bash
xyte-cli tui --headless --screen config --format json --once --tenant <tenant-id>
```

## Safety Model

- Headless frames are read-only visualization.
- Mutations still must go through guarded CLI commands:
  - non-read methods require `--allow-write`
  - delete methods require `--allow-write --confirm <endpoint-key>`
