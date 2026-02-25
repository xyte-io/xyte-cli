# Headless Flows (Agent-First)

Use `xyte-cli tui --headless` as the visual/tooling interface for agents.

## Base Pattern

```bash
xyte-cli tui --headless --screen <screen> --format json --once --tenant <tenant-id>
```

## Watch-First Triage Handoff

For incident operations, run this sequence before any optional writes:

1. Watch snapshot and short delta loop:
```bash
xyte-cli watch --tenant <tenant-id> --profile incidents-active --once --strict-json
xyte-cli watch --tenant <tenant-id> --profile incidents-active --interval-ms 2000 --max-polls 30 --strict-json
```

2. Triage artifacts:
```bash
xyte-cli inspect fleet --tenant <tenant-id> --format json > /tmp/xyte-fleet.triage.json
xyte-cli inspect deep-dive --tenant <tenant-id> --window 24 --format json > /tmp/xyte-deep-dive.triage.json
xyte-cli report generate --tenant <tenant-id> --input /tmp/xyte-deep-dive.triage.json --out /tmp/xyte-triage.md --format markdown
```

3. Optional write handoff:
- run writes only after explicit human approval.
- run `organization.commands.getCommands` preflight before `organization.commands.sendCommand`.
- after `organization.devices.updateDevice`, read back with `organization.devices.getDevice` and verify target fields changed.
- non-read endpoint calls require `--allow-write`.
- destructive deletes require `--allow-write --confirm <endpoint-key>`.
- `space import-tree` remains dry-run unless `--apply` is provided.

Supported screens:
- `setup`
- `config`
- `dashboard`
- `spaces`
- `devices`
- `incidents`
- `tickets`

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
- `actionsHint` (interactive action summary for current screen)
- `writePolicy` (expected mutation policy; currently organization-only)
- `headlessWrite` (must be `false`)
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
- Headless never executes writes; use interactive `xyte-cli tui` for TUI mutations.
- Mutations still must go through guarded CLI commands:
  - non-read methods require `--allow-write`
  - delete methods require `--allow-write --confirm <endpoint-key>`
