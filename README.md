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
xyte-cli init

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
npm exec @xyteai/cli@latest -- <command>
```

### 2) Install agent skills

```bash
xyte-cli init
```

### 3) Connect with tenant-bound API key

```bash
xyte-cli setup run
xyte-cli setup status --field tenantId
```

Use that value as `<tenant-id>` in the examples below. For non-interactive automation, use the shell-neutral `--key-stdin` path documented in [`docs/getting-started.md`](./docs/getting-started.md).

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

### 4) Guided remediation plan (no writes)

```bash
xyte-cli flow run flow.guided-remediation --tenant <tenant-id> --var incident_id=<incident-id> --var device_id=<device-id> --var command=reboot --var updated_device_name=<device-name>
```

Key params:
- `flow run` defaults to plan mode
- `--var key=value` for runtime context
- `--resume <run-id-or-path>` for follow-up runs

### 5) Write example

Primary read/setup/reporting workflows are shell-neutral. Advanced raw API examples like this one remain shell-specific because inline JSON quoting differs across PowerShell, CMD, Bash, and zsh.

```bash
xyte-cli api call organization.commands.sendCommand \
  --tenant <tenant-id> \
  --path-json '{"device_id":"<device-id>"}' \
  --body-json '{"command":"reboot"}'
```

Behavior:
- executes directly once you choose the write step

### 6) Fleet insights and deep-dive data

```bash
xyte-cli ops inspect fleet --tenant <tenant-id> --provider-scope auto --output json
xyte-cli ops inspect deep-dive --tenant <tenant-id> --provider-scope auto --window 24 --output json --out ./artifacts/deep-dive.json
```

Key params:
- `--provider-scope organization|partner|auto`
- `--window <hours>` for deep-dive
- `--output json` for pipelines

### 7) Generate PDF report

```bash
xyte-cli ops report generate --tenant <tenant-id> --input ./artifacts/deep-dive.json --out ./reports/fleet-report.pdf
```

Key params:
- `--input` deep-dive JSON
- `--out` target PDF path

### 8) Headless console snapshots (for agents/automation)

```bash
xyte-cli ops console --headless --screen dashboard --once --tenant <tenant-id> --output json
xyte-cli ops console --headless --screen spaces --follow --interval-ms 2000 --tenant <tenant-id> --output json
```

Key params:
- `--screen dashboard|spaces|...`
- `--once` snapshot mode
- `--follow` stream mode

### 9) Utility preprocessing + import-tree

```bash
xyte-cli util list-actions --output text

xyte-cli util prepare \
  --action space.import-tree \
  --input ./raw-hierarchy.xlsx \
  --output-dir ./prepared

xyte-cli util import-tree --tenant <tenant-id> --input ./prepared/space-import-tree.csv
xyte-cli util import-tree --tenant <tenant-id> --input ./prepared/space-import-tree.csv --apply --report ./reports/space-import.apply.ndjson
```

Key params:
- `util prepare --action ... --input ... --output-dir ...`
- `util import-tree` is dry-run unless `--apply`
- `--report` writes apply NDJSON report

### 10) Upgrade flow

```bash
xyte-cli upgrade --check --output json
xyte-cli upgrade --yes --output json
```

Key params:
- `--check` dry check
- `--yes` non-interactive upgrade

### 11) Action logs and diagnostics

```bash
xyte-cli --log-actions --log-actions-path ./logs/xyte-cli.actions.ndjson status --tenant <tenant-id>
xyte-cli logs list --path ./logs/xyte-cli.actions.ndjson --limit 200
xyte-cli logs stats --path ./logs/xyte-cli.actions.ndjson
```

Key params:
- `--log-actions` lifecycle NDJSON
- `logs list|stats|gc|view` for operations logs

---

## Deep Docs

- [Getting started](./docs/getting-started.md)
- [Commands reference](./docs/commands.md)
- [Agent guidance](./docs/agents.md)
- [Flow authoring](./docs/flows/custom-workflows.md)
- [Schema contracts](./docs/schemas)
