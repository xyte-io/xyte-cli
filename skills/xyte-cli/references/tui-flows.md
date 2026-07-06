# Headless Flows (Agent-First)

Use `xyte-cli ops console --headless` as the visual/tooling interface for agents.

## Base Pattern

```bash
xyte-cli ops console --headless --screen <screen> --output json --once --tenant <tenant-id>
```

## Credential Storage Notes

- Persisted credentials default to secure OS-native storage under `auth.secretStoreBackend=auto`: macOS Keychain, Windows DPAPI, Linux Secret Service.
- If native storage is unavailable under `auto`, setup/config/readiness commands may warn on `stderr` and fall back to file storage. Treat that warning alone as non-fatal when the exit code and `stdout` JSON are otherwise valid.
- `xyte-cli config path --output json` reports backend diagnostics. `secretStore` may be a backend identifier, not always a filesystem path.

## Watch-First Triage Handoff

For incident operations, run this sequence before any optional writes:

1. Watch snapshot and short delta loop:

```bash
xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --output json --strict-json
xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --interval-ms 2000 --max-polls 30 --output json --strict-json
```

2. Triage artifacts:

```bash
xyte-cli ops inspect fleet --tenant <tenant-id> --output json --out ./artifacts/xyte-fleet.triage.json
xyte-cli ops inspect deep-dive --tenant <tenant-id> --window 24 --output json --out ./artifacts/xyte-deep-dive.triage.json
xyte-cli ops report generate --tenant <tenant-id> --input ./artifacts/xyte-deep-dive.triage.json --out ./artifacts/xyte-triage.md --render markdown
```

3. Optional write handoff:
- run writes only after explicit human approval
- before `organization.commands.sendCommand`, read the selected device, describe its model, and choose only from model `commands[]`; use `getCommands` afterward only for queue/history verification
- after `organization.devices.updateDevice`, read back with `organization.devices.getDevice` and verify target fields changed
- `xyte-cli util import-tree` remains dry-run unless `--apply` is provided

Supported screens:
- `setup`
- `config`
- `dashboard`
- `spaces`
- `devices`
- `incidents`
- `tickets`

## Deterministic Branching (Required)

1. Request an operational screen (for example `dashboard`).
2. Parse the last non-startup frame.
3. If `frame.screen == "setup"` and `frame.meta.redirectedFrom` is set:
- treat tenant/keys/setup as blocking
- switch to setup/config remediation flow
4. Retry the requested operational screen after remediation.

## Setup/Config Remediation Flow

1. Check the readiness frame:

```bash
xyte-cli ops console --headless --screen setup --output json --once --tenant <tenant-id>
```

2. If auth is missing, use the setup flow or CLI key-slot operations:

```bash
xyte-cli setup run --tenant <tenant-id> [--provider <xyte-org|xyte-partner>]
xyte-cli setup status --tenant <tenant-id> --field tenantId
xyte-cli config key list --tenant <tenant-id> --output json
xyte-cli config doctor --tenant <tenant-id> --output json
```

The interactive API key prompt hides input: paste the key, press Enter, and check that the `Received <N> characters.` confirmation matches the key length.
For non-interactive automation, use `--key-file <path-outside-workspace>` or pipe the key on stdin to `xyte-cli setup run --non-interactive --tenant <tenant-id> [--provider <xyte-org|xyte-partner>] --key-stdin`. To resolve the key from a secret manager, use `--key-command "<cmd>"` (e.g. `op read op://Employee/Xyte/credential`, `vault kv get -field=key secret/xyte`, `aws secretsmanager get-secret-value --secret-id xyte --query SecretString --output text`); xyte-cli runs the command and uses its stdout as the key.
If `--provider` is omitted, setup probes `xyte-org` first and then `xyte-partner`. If `--connectivity never` is used, require `--provider`.
Persisted credentials default to secure OS-native storage (macOS Keychain, Windows DPAPI, Linux Secret Service). If `xyte-cli` warns on stderr that secure storage was unavailable and it fell back to file storage, treat that as degraded-but-successful setup rather than command failure.

3. Re-request the operational headless frame.

## Per-Screen Headless Recipes

Setup:

```bash
xyte-cli ops console --headless --screen setup --output json --once --tenant <tenant-id>
```

Config:

```bash
xyte-cli ops console --headless --screen config --output json --once --tenant <tenant-id>
```

Dashboard:

```bash
xyte-cli ops console --headless --screen dashboard --output json --once --tenant <tenant-id>
```

Spaces:

```bash
xyte-cli ops console --headless --screen spaces --output json --once --tenant <tenant-id>
```

Devices:

```bash
xyte-cli ops console --headless --screen devices --output json --once --tenant <tenant-id>
```

Incidents:

```bash
xyte-cli ops console --headless --screen incidents --output json --once --tenant <tenant-id>
```

Tickets:

```bash
xyte-cli ops console --headless --screen tickets --output json --once --tenant <tenant-id>
```

## Follow Mode (Streaming)

```bash
xyte-cli ops console --headless --screen spaces --output json --follow --interval-ms 2000 --tenant <tenant-id>
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
- `redirectedFrom` (when the setup gate blocks)
- `actionsHint` (interactive action summary for the current screen)
- `writePolicy` (expected mutation policy; currently organization-only)
- `headlessWrite` (must be `false`)
- `contract.frameVersion`
- `contract.tableFormat`
- `contract.navigationMode`

## Output Mode

Headless is JSON-only. Always parse NDJSON frames:

```bash
xyte-cli ops console --headless --screen config --output json --once --tenant <tenant-id>
```

## Safety Model

- Headless frames are read-only visualization.
- Headless never executes writes; use interactive `xyte-cli ops console` for console mutations.
- Endpoint mutations still go through `xyte-cli api call` after explicit user approval.
