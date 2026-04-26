# xyte-cli

Deterministic Xyte operations for humans and AI agents.

- npm: [@xyteai/cli](https://www.npmjs.com/package/@xyteai/cli)
- GitHub Page: [docs/index.html](./docs/index.html)
- Command reference: [docs/commands.md](./docs/commands.md)
- Flows: [docs/flows/agent-ops.md](./docs/flows/agent-ops.md)
- Schemas: [docs/schemas](./docs/schemas)

## AI Agent Prompt (Copy/Paste)

```text
Use @xyteai/cli in this workspace. Keep it concise and safe.

Rules:
- Never print secrets.
- Do not invent IDs or outputs.

Run:
npm install -g @xyteai/cli@latest
xyte-cli --version
xyte-cli init --no-setup

Then connect the tenant:
xyte-cli setup run
xyte-cli setup status --field tenantId

Read tenantId from setup status and continue:
xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --output json --strict-json
xyte-cli ops inspect deep-dive --tenant <tenant-id> --window 24 --output json --out ./artifacts/deep-dive.json
xyte-cli ops report generate --tenant <tenant-id> --input ./artifacts/deep-dive.json --out ./reports/fleet-report.pdf

Finish with:
- concise success/failure summary
- exact failing command (if any)
```

---

## Install Flow

### 1) Install CLI

```bash
npm install -g @xyteai/cli@latest
xyte-cli --version
```

If your global npm bin is not on `PATH`, replace `xyte-cli` in the commands below with one of these published-package fallbacks:

```bash
npx @xyteai/cli@latest <command>
npm exec -- @xyteai/cli@latest <command>
```

### 2) Install agent skills

```bash
xyte-cli init --no-setup
```

### 3) Connect with tenant-bound API key

```bash
xyte-cli setup run
xyte-cli setup status --field tenantId
```

Use that value as `<tenant-id>` in the examples below. Persisted credentials default to secure OS-native storage: macOS Keychain, Windows DPAPI, Linux Secret Service. If native storage is unavailable, `xyte-cli` warns and falls back to file storage. For non-interactive automation and backend details, use the setup guidance in [`docs/getting-started.md`](./docs/getting-started.md).

---

## Examples (Feature Catalog)

### 1) Endpoint discovery

```bash
xyte-cli api endpoints list
xyte-cli api endpoints describe organization.devices.getDevices
```

Key params:
- `api endpoints describe <endpoint-key>`

### 2) Read endpoint call (safe)

```bash
xyte-cli api call organization.devices.getDevices --tenant <tenant-id>
```

Key params:
- `--tenant <tenant-id>`
- `--output-mode envelope` for contract output
- `--strict-json` for machine parsing

### 3) Incident watch (active incidents)

```bash
xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once
xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --interval-ms 2000 --max-polls 10
```

Key params:
- terminal output is human-readable by default; add `--output json --strict-json` for machine parsing
- `--once` one snapshot poll and exit
- `--interval-ms` minimum `1000`
- `--max-polls` bounded polling

### 4) Flow discovery and guided remediation

```bash
xyte-cli flow list --format text
xyte-cli flow run flow.guided-remediation --tenant <tenant-id> --var incident_id=<incident-id> --var device_id=<device-id> --var command=reboot --var updated_device_name=<device-name>
```

Key params:
- `flow run` defaults to plan mode
- `--var key=value` for runtime context
- non-completed runs include `nextAction` with the safest next operator command
- gate continuation is `--apply --resume <run-id-or-path>`

### 5) Tenant and key slots

```bash
xyte-cli config tenant add <tenant-id> --name "Acme"
xyte-cli config tenant use <tenant-id>
xyte-cli config key add --tenant <tenant-id> --provider xyte-org --name primary --key-file ~/.config/xyte/acme.key --set-active
xyte-cli config key list --tenant <tenant-id> --output json
xyte-cli config tenant remove <tenant-id> --confirm
```

Key params:
- `config tenant remove` requires `--confirm`
- prefer `--key-file`, `--key-stdin`, or `--key-command` over inline keys
- pass `--provider xyte-org|xyte-partner` when you need deterministic routing

### 6) Write example

Primary read/setup/reporting workflows are shell-neutral. Advanced raw API examples like this one remain shell-specific because inline JSON quoting differs across PowerShell, CMD, Bash, and zsh.

```bash
xyte-cli api call organization.commands.sendCommand \
  --tenant <tenant-id> \
  --path-json '{"device_id":"<device-id>"}' \
  --body-json '{"command":"reboot"}'
```

Behavior:
- executes directly once you choose the write step

### 7) Fleet insights and deep-dive data

```bash
xyte-cli ops inspect fleet --tenant <tenant-id> --provider-scope auto --output json
xyte-cli ops inspect deep-dive --tenant <tenant-id> --provider-scope auto --window 24 --output json --out ./artifacts/deep-dive.json
```

Key params:
- `--provider-scope organization|partner|auto`
- `--window <hours>` for deep-dive
- `--output json` for pipelines

### 8) Generate report artifacts

```bash
xyte-cli ops report generate --tenant <tenant-id> --input ./artifacts/deep-dive.json --render pdf --out ./reports/fleet-report.pdf
xyte-cli ops report generate --tenant <tenant-id> --input ./artifacts/deep-dive.json --render markdown --out ./reports/fleet-report.md
```

Key params:
- `--input` deep-dive JSON
- `--render markdown|pdf` for artifact format
- `--output text|json` controls stdout, not report rendering

### 9) Headless console snapshots (for agents/automation)

```bash
xyte-cli ops console --headless --screen dashboard --once --tenant <tenant-id> --output json
xyte-cli ops console --headless --screen spaces --follow --interval-ms 2000 --tenant <tenant-id> --output json
```

Key params:
- `--screen dashboard|spaces|...`
- `--once` snapshot mode
- `--follow` stream mode

### 10) Utility preprocessing + executable workflows

```bash
xyte-cli util list-actions --output text --mode friendly
xyte-cli util list-actions --output text --execution-support edge.claim-batch

xyte-cli util prepare \
  --action space.import-tree \
  --input ./raw-hierarchy.xlsx \
  --output-dir ./prepared

xyte-cli util import-tree --tenant <tenant-id> --input ./prepared/space-import-tree.csv
xyte-cli util import-tree --tenant <tenant-id> --input ./prepared/space-import-tree.csv --apply --report ./reports/space-import.apply.ndjson

xyte-cli util match \
  --source ./source-devices.json --target ./target-spaces.json \
  --source-field name --target-field name \
  --out ./device-moves.csv

xyte-cli util move-devices --tenant <tenant-id> --input ./device-moves.csv
xyte-cli util move-devices --tenant <tenant-id> --input ./device-moves.csv --apply --report ./reports/device-moves.apply.ndjson
```

Key params:
- `util prepare --action ... --input ... --output-dir ...`
- `util import-tree` and `util move-devices` are dry-run unless `--apply`
- dry-runs count validated rows under `totals.planned`; `totals.succeeded` is for apply mode
- generated `.notes.md` files are the human review artifact for prepared data
- `--report` writes an NDJSON row report

### 11) Claim devices

Use [`docs/claim-devices.md`](./docs/claim-devices.md) first when the claim path is not explicit. Native/direct, Edge, and C2C are different flows.

```bash
# Native / direct claim
xyte-cli api call organization.devices.claimDevice \
  --tenant <tenant-id> \
  --body-json '{"name":"<name>","space_id":<space-id>,"sn":"<sn>","mac":"<mac>","cloud_id":"<cloud-id>"}'

# Single Edge claim, plan first
xyte-cli edge claim \
  --tenant <tenant-id> \
  --proxy-id <proxy-id> \
  --device-ip <device-ip> \
  --device-model-id <device-model-id> \
  --space-id <space-id> \
  --plan

# Bulk Edge claim, plan first
xyte-cli util prepare --action organization.edge.startClaim --input ./edge-devices.xlsx --output-dir ./prepared
xyte-cli edge claim-batch --tenant <tenant-id> --input ./prepared/organization-edge-startclaim.csv --plan
xyte-cli edge claim-batch --tenant <tenant-id> --input ./prepared/organization-edge-startclaim.csv --apply --report ./reports/edge-claim.apply.ndjson --resume-artifact ./reports/edge-claim.resume.ndjson
```

Key params:
- `edge claim`, `edge claim-batch`, and `edge ping` are mutating; run `--plan` first
- blank or `skip_connectivity_check=false` batch rows run a pre-claim ping before `startClaim`
- `skip_connectivity_check=true` rows skip that batch-owned ping
- C2C claiming is not exposed through the public API; use the End Customer Portal

### 12) Edge diagnostics

```bash
xyte-cli edge claim-status --tenant <tenant-id> --proxy-id <proxy-id> --device-ip <device-ip>
xyte-cli edge ping --tenant <tenant-id> --proxy-id <proxy-id> --device-ip <device-ip> --plan
xyte-cli edge ping-status --tenant <tenant-id> --proxy-id <proxy-id> --device-ip <device-ip>
```

Key params:
- `edge claim-status` and `edge ping-status` are read-only
- `edge ping` is a standalone diagnostic command
- batch claim owns its own pre-claim ping for rows that require connectivity verification

### 13) Upgrade flow

```bash
xyte-cli upgrade --check --output json
xyte-cli upgrade --yes --output json
```

Key params:
- `--check` dry check
- `--yes` non-interactive upgrade

### 14) Action logs and diagnostics

```bash
xyte-cli --log-actions --log-actions-path ./logs/xyte-cli.actions.ndjson status --tenant <tenant-id>
xyte-cli logs list --path ./logs/xyte-cli.actions.ndjson --limit 200
xyte-cli logs list --path ./logs/xyte-cli.actions.ndjson --session-id <session-id> --output json
xyte-cli logs show --path ./logs/xyte-cli.actions.ndjson --entry <sessionId>:<seq> --output json
xyte-cli logs show --path ./logs/xyte-cli.actions.ndjson --request-id <request-id> --output json
xyte-cli logs stats --path ./logs/xyte-cli.actions.ndjson
```

Key params:
- `--log-actions` lifecycle NDJSON
- `logs list --session-id` narrows a run
- `logs show --entry` and `logs show --request-id` are exact non-interactive lookups

---

## Deep Docs

- [Getting started](./docs/getting-started.md)
- [Commands reference](./docs/commands.md)
- [Claim devices](./docs/claim-devices.md)
- [Utility preprocessing](./docs/ai-utility-preprocessing.md)
- [Agent guidance](./docs/agents.md)
- [Flow authoring](./docs/flows/custom-workflows.md)
- [Schema contracts](./docs/schemas)
