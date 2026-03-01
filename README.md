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
- Do not use --allow-write.
- Do not invent IDs or outputs.

Run:
npm install -g @xyteai/cli@latest
xyte-cli install --skills

Then ask me for XYTE_CLI_KEY and run:
XYTE_CLI_KEY="<key>" xyte-cli setup run --non-interactive --connectivity auto
xyte-cli setup status --format json

Read tenantId from setup status and continue:
xyte-cli watch --tenant <tenant-id> --profile incidents-active --once
xyte-cli inspect deep-dive --tenant <tenant-id> --window 24 --format json > deep-dive.json
xyte-cli report generate --tenant <tenant-id> --input deep-dive.json --out fleet-report.pdf

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

### 2) Install agent skills

```bash
xyte-cli install --skills
```

### 3) Connect with tenant-bound API key

```bash
XYTE_CLI_KEY="<key>" xyte-cli setup run --non-interactive --connectivity auto
xyte-cli setup status --format json
```

### 4) Extract active tenant id from setup status (optional helper)

```bash
xyte-cli setup status --format json | jq -r '.tenantId'
```

Use that value as `<tenant-id>` in the examples below.

---

## Examples (Feature Catalog)

### 1) Endpoint discovery

```bash
xyte-cli list-endpoints
xyte-cli describe-endpoint organization.devices.getDevices
```

Key params:
- `describe-endpoint <endpoint-key>`

### 2) Read endpoint call (safe)

```bash
xyte-cli call organization.devices.getDevices --tenant <tenant-id>
```

Key params:
- `--tenant <tenant-id>`
- `--output-mode envelope` for contract output
- `--strict-json` for machine parsing

### 3) Incident watch (active incidents)

```bash
xyte-cli watch --tenant <tenant-id> --profile incidents-active --once
xyte-cli watch --tenant <tenant-id> --profile incidents-active --interval-ms 2000 --max-polls 10
```

Key params:
- `--once` one snapshot frame
- `--interval-ms` minimum `1000`
- `--max-polls` bounded polling

### 4) Guided remediation plan (no writes)

```bash
xyte-cli flow run flow.guided-remediation \
  --tenant <tenant-id> \
  --var incident_id=<incident-id> \
  --var device_id=<device-id> \
  --var command=reboot \
  --var updated_device_name=<device-name>
```

Key params:
- `flow run` defaults to plan mode
- `--var key=value` for runtime context
- `--resume <run-id-or-path>` for follow-up runs

### 5) Write safety guardrail

```bash
xyte-cli call organization.commands.sendCommand \
  --tenant <tenant-id> \
  --path-json '{"device_id":"<device-id>"}' \
  --body-json '{"command":"reboot"}'
```

Behavior:
- blocked without `--allow-write`

### 6) Fleet insights and deep-dive data

```bash
xyte-cli inspect fleet --tenant <tenant-id> --provider-scope auto --format json
xyte-cli inspect deep-dive --tenant <tenant-id> --provider-scope auto --window 24 --format json > deep-dive.json
```

Key params:
- `--provider-scope organization|partner|auto`
- `--window <hours>` for deep-dive
- `--format json` for pipelines

### 7) Generate PDF report

```bash
xyte-cli report generate --tenant <tenant-id> --input deep-dive.json --out fleet-report.pdf
```

Key params:
- `--input` deep-dive JSON
- `--out` target PDF path

### 8) Headless TUI snapshots (for agents/automation)

```bash
xyte-cli tui --headless --screen dashboard --once --tenant <tenant-id> --format json
xyte-cli tui --headless --screen spaces --follow --interval-ms 2000 --tenant <tenant-id> --format json
```

Key params:
- `--screen dashboard|spaces|...`
- `--once` snapshot mode
- `--follow` stream mode

### 9) Utility preprocessing + import-tree

```bash
xyte-cli utility list-actions --format text

xyte-cli utility prepare \
  --action space.import-tree \
  --input ./raw-hierarchy.xlsx \
  --output-dir ./prepared

xyte-cli space import-tree --tenant <tenant-id> --input ./prepared/space-import-tree.csv
xyte-cli space import-tree --tenant <tenant-id> --input ./prepared/space-import-tree.csv --apply --report ./space-import.apply.ndjson
```

Key params:
- `utility prepare --action ... --input ... --output-dir ...`
- `space import-tree` is dry-run unless `--apply`
- `--report` writes apply NDJSON report

### 10) Upgrade flow

```bash
xyte-cli upgrade --check --format json
xyte-cli upgrade --yes --format json
```

Key params:
- `--check` dry check
- `--yes` non-interactive upgrade

### 11) Action logs and diagnostics

```bash
xyte-cli --log-actions --log-actions-path /tmp/xyte-cli.actions.ndjson status --tenant <tenant-id>
xyte-cli logs list --path /tmp/xyte-cli.actions.ndjson --limit 200
xyte-cli logs stats --path /tmp/xyte-cli.actions.ndjson
```

Key params:
- `--log-actions` lifecycle NDJSON
- `logs list|stats|gc|view` for operations logs

---

## Video Stories

### Install CLI

[![Install CLI](./docs/assets/videos/01-install-cli.gif)](./docs/assets/videos/01-install-cli.mp4)

### Install Skills

[![Install Skills](./docs/assets/videos/02-install-skills.gif)](./docs/assets/videos/02-install-skills.mp4)

### Connect API Key

[![Connect API Key](./docs/assets/videos/03-connect-api-key.gif)](./docs/assets/videos/03-connect-api-key.mp4)

### Watch Incidents

[![Watch Incidents](./docs/assets/videos/06-watch-incidents.gif)](./docs/assets/videos/06-watch-incidents.mp4)

### Export PDF Report

[![Export PDF Report](./docs/assets/videos/09-weekly-pdf-report.gif)](./docs/assets/videos/09-weekly-pdf-report.mp4)

---

## Deep Docs

- [Getting started](./docs/getting-started.md)
- [Commands reference](./docs/commands.md)
- [Agent guidance](./docs/agents.md)
- [Flow authoring](./docs/flows/custom-workflows.md)
- [Schema contracts](./docs/schemas)
