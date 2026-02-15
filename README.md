# xyte-cli

Xyte CLI with SKILLS, built for coding agents and operators.

`xyte-cli` provides deterministic access to Xyte APIs, a full TUI (without a Network tab), guarded write flows, headless NDJSON snapshots, and an MCP server.

### xyte-cli vs xyte MCP

- **CLI**: best fit for coding agents that need low-token, command-driven workflows.
- **MCP**: available for tool-based integrations and external orchestration via `xyte-cli mcp serve`.

### Key Features

- One-command skill install flow: `xyte-cli install --skills`
- Guided setup embedded into install flow (unless `--no-setup`)
- Provider/slot key lifecycle (`add`, `use`, `update`, `rename`, `test`, `remove`)
- Guarded endpoint writes (`--allow-write`) and deletes (`--confirm <endpoint-key>`)
- Full TUI screens:
  - `setup`, `config`, `dashboard`, `spaces`, `devices`, `incidents`, `tickets`
- Provider-first Config screen with hotkeys:
  - `a`, `e`, `u`, `t`, `x`, `n`, `c`, `r`
- Headless JSON frames with stable contracts
- Inspect/report pipelines with schema-versioned output

## Requirements

- Node.js 18+
- A valid XYTE API key
- Supported keychain backend:
  - macOS Keychain
  - Linux `secret-tool`
  - test/runtime override: `XYTE_CLI_KEYCHAIN_BACKEND=memory`

## Getting Started

## Installation

```bash
npm install -g @xyte/cli@latest
xyte-cli --help
```

### Install skills (recommended)

```bash
xyte-cli install --skills
```

By default, this command prompts for:
- install scope: `project`, `user`, or `both`
- agents: `all` or a subset of `claude,copilot,codex`

Then it installs the same skill bundle to the selected destinations and runs guided setup in the same flow.

When no prompt is available (CI/non-interactive), default is:
- scope: `project`
- agents: `all` (`claude`, `copilot`, `codex`)

Path mapping:
- Project scope:
  - Claude: `.claude/skills/xyte-cli`
  - Copilot: `.github/skills/xyte-cli`
  - Codex: `.agents/skills/xyte-cli`
- User scope:
  - Claude: `~/.claude/skills/xyte-cli`
  - Copilot: `~/.copilot/skills/xyte-cli`
  - Codex: `~/.agents/skills/xyte-cli`

Options:

```bash
xyte-cli install --skills --no-setup
xyte-cli install --skills --target /path/to/workspace
xyte-cli install --skills --scope project --agents claude,codex
xyte-cli install --skills --scope both --agents all --force
xyte-cli install --skills --force
```

### Non-interactive setup

```bash
XYTE_CLI_KEY="<your-key>" \
xyte-cli setup run --non-interactive --tenant acme
```

### Skills-less operation

Point your agent to `xyte-cli --help` and ask it to use CLI commands directly.

Example prompt:

```text
Use xyte-cli to inspect tenant acme and generate a PDF report.
Check xyte-cli --help first and keep outputs in JSON when possible.
```

## Visual Demo

![XYTE TUI dashboard](docs/media/tui-dashboard-synthetic.png)

![XYTE headless frame](docs/media/headless-frame-synthetic.png)

## Commands

### Core

```bash
xyte-cli install --skills [--target <path>] [--scope <project|user|both>] [--agents <all|claude|copilot|codex[,..]>] [--force] [--no-setup]
xyte-cli doctor install --format json
xyte-cli setup status --tenant <tenant-id> --format json
xyte-cli setup run [--non-interactive] [--tenant <tenant-id>] [--key <value>]
xyte-cli config doctor --tenant <tenant-id> --format json
```

### Tenant + Auth Slots

```bash
xyte-cli tenant add <tenant-id> --name "Acme"
xyte-cli tenant use <tenant-id>
xyte-cli tenant list

xyte-cli auth key add --tenant <tenant-id> --provider xyte-org --name primary --key "<value>" --set-active
xyte-cli auth key list --tenant <tenant-id> --format json
xyte-cli auth key use --tenant <tenant-id> --provider xyte-org --slot primary
xyte-cli auth key update --tenant <tenant-id> --provider xyte-org --slot primary --key "<value>"
xyte-cli auth key rename --tenant <tenant-id> --provider xyte-org --slot primary --name prod-primary
xyte-cli auth key test --tenant <tenant-id> --provider xyte-org --slot prod-primary
xyte-cli auth key remove --tenant <tenant-id> --provider xyte-org --slot prod-primary --confirm
```

### Endpoint Operations

```bash
xyte-cli list-endpoints
xyte-cli describe-endpoint organization.devices.getDevices
xyte-cli call organization.devices.getDevices --tenant <tenant-id>
xyte-cli call organization.devices.getDevices --tenant <tenant-id> --output-mode envelope
```

### Guarded Writes

```bash
xyte-cli call organization.commands.sendCommand \
  --tenant <tenant-id> \
  --allow-write \
  --path-json '{"device_id":"DEVICE_ID"}' \
  --body-json '{"name":"reboot"}'

xyte-cli call organization.commands.cancelCommand \
  --tenant <tenant-id> \
  --allow-write \
  --confirm organization.commands.cancelCommand \
  --path-json '{"device_id":"DEVICE_ID","command_id":"COMMAND_ID"}'
```

### Insights + Reports

```bash
xyte-cli inspect fleet --tenant <tenant-id> --format json
xyte-cli inspect deep-dive --tenant <tenant-id> --window 24 --format json > /tmp/deep-dive.json
xyte-cli report generate --tenant <tenant-id> --input /tmp/deep-dive.json --out /tmp/xyte-report.pdf
```

### TUI + Headless

```bash
xyte-cli tui
xyte-cli tui --headless --screen dashboard --format json --once --tenant <tenant-id>
xyte-cli tui --headless --screen spaces --format json --follow --interval-ms 2000 --tenant <tenant-id>
```

### MCP

```bash
xyte-cli mcp serve
```

## Headless Contract IDs

- `xyte.headless.frame.v1`
- `xyte.call.envelope.v1`
- `xyte.inspect.fleet.v1`
- `xyte.inspect.deep-dive.v1`
- `xyte.report.v1`

Schemas:

- `docs/schemas/headless-frame.v1.schema.json`
- `docs/schemas/call-envelope.v1.schema.json`
- `docs/schemas/inspect-fleet.v1.schema.json`
- `docs/schemas/inspect-deep-dive.v1.schema.json`
- `docs/schemas/report.v1.schema.json`

## Agent Quick Start

### Claude

```bash
xyte-cli install --skills
claude
```

### Codex

```bash
xyte-cli install --skills
# in Codex prompts, ask to run xyte-cli commands directly
```

### GitHub Copilot

```bash
xyte-cli install --skills
# in Copilot prompts, ask to run xyte-cli commands directly
```

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm pack
```

Local package smoke:

```bash
npm i -g ./xyte-cli-*.tgz
xyte-cli install --skills --no-setup
```

## Release

Manual npm release steps are documented in:

- `docs/release.md`

## Skill Package Layout

- `skills/xyte-cli/SKILL.md`
- `skills/xyte-cli/references/`
- `skills/xyte-cli/scripts/`
- `skills/xyte-cli/agents/`
