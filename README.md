# xyte-cli

Built for shell-capable AI agents and automated terminal workflows.
Manual terminal use is supported for setup, debugging, and local testing.

- npm: [@xyteai/cli](https://www.npmjs.com/package/@xyteai/cli)
- GitHub Page: [docs/index.html](./docs/index.html)
- Command reference: [docs/commands.md](./docs/commands.md)
- Flows: [docs/flows/agent-ops.md](./docs/flows/agent-ops.md)
- Schemas: [docs/schemas](./docs/schemas)

## Install Flow

### AI agent

Use this path for Codex, Claude Code/Desktop, GitHub Copilot CLI, VS Code Copilot Agent, and other shell-capable agents. Chat-only assistants can explain commands, but they cannot install the CLI.

Start with environment diagnostics. The report picks the right install mode for this environment and returns copy-pasteable commands in `recommendations`:

```sh
xyte-cli doctor environment --format json
```

If `xyte-cli` is missing:

```sh
npx -y @xyteai/cli@latest doctor environment --format json
```

If the report recommends `workspace-local` mode:

```sh
npm install --prefix ./.xyte-cli/runtime @xyteai/cli@latest
./.xyte-cli/runtime/node_modules/.bin/xyte-cli <command>
```

PowerShell command path:

```powershell
.\.xyte-cli\runtime\node_modules\.bin\xyte-cli.cmd <command>
```

Before you start: in Xyte, open **Settings → API Keys** and create a key. Save it in a plain text file outside your project folder (for example `xyte-api-key.txt` on your Desktop) — any text editor works. Your agent will ask for the file's path. Do not paste API keys into chat. Do not store API keys inside the repo.

Agent prompt (copy/paste):

```text
Use @xyteai/cli in this workspace.
Never print secrets. Do not invent IDs or outputs.

First run `xyte-cli doctor environment --format json`.
If `xyte-cli` is missing, run `npx -y @xyteai/cli@latest doctor environment --format json`.
Follow the report's recommendations.nextCommand and recommendations.commands.

If `xyte-cli setup status` shows no connected tenant, ask me for the path to my API key file (never the key itself) and connect it with the report's setupKeyFile recipe.
Do not ask me to paste API keys into chat.
Do not store API keys inside the repo.
After setup succeeds, offer to delete the key file, then run `xyte-cli init --scope project --agents all --force --no-setup`.

If this surface cannot run shell commands, stop and say I need a shell-capable terminal or agent.
```

Detailed agent guidance: [docs/agents.md](./docs/agents.md).

### CI / headless

1. In Xyte, open **Settings → API Keys** and create a key.
2. In your CI tool (GitHub Actions, GitLab CI, Jenkins), add a secret named `XYTE_CLI_KEY` and paste the key as its value.
3. Add these commands to your pipeline (`acme` is just a name for this connection — use your company name):

```sh
npx -y @xyteai/cli@latest setup run --non-interactive --tenant acme --output json
npx -y @xyteai/cli@latest setup status --tenant acme --field tenantId
```

For reproducible pipelines, replace `@latest` with a pinned version (e.g. `@0.10.7`).

### Manual terminal

Install [Node.js 22+](https://nodejs.org/en/download) first if `node --version` is missing or below 22 (macOS: `brew install node@22`, Windows: `winget install OpenJS.NodeJS.LTS`).

```sh
npm install -g @xyteai/cli@latest
xyte-cli --version
xyte-cli setup run
xyte-cli setup status --field tenantId
xyte-cli init --no-setup
```

If your global npm bin is not on `PATH`, replace `xyte-cli` in the commands below with one of these published-package fallbacks:

```sh
npx -y @xyteai/cli@latest <command>
npm exec -- @xyteai/cli@latest <command>
```

Use the `setup status` tenant value as `<tenant-id>` in the examples below. Persisted credentials default to secure OS-native storage: macOS Keychain, Windows DPAPI, Linux Secret Service. If native storage is unavailable, `xyte-cli` warns and falls back to file storage. For non-interactive automation and backend details, use the setup guidance in [`docs/getting-started.md`](./docs/getting-started.md).

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

xyte-cli util prepare \
  --action organization.connectors.prepareSetup \
  --input ./raw-connectors.csv \
  --output-dir ./prepared

xyte-cli util prepare \
  --action organization.teamAccess.groups \
  --input ./raw-team.csv \
  --output-dir ./prepared

xyte-cli util prepare \
  --action organization.teamAccess.users \
  --input ./raw-team.csv \
  --output-dir ./prepared

xyte-cli util prepare \
  --action organization.teamAccess.memberships \
  --input ./raw-team.csv \
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
- connector and team-access prepare actions are prepare-only normalization utilities
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
