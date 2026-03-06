# Getting Started

## Requirements

- Node.js 18+
- A valid Xyte API key
- Writable local config directory (override with `XYTE_CLI_CONFIG_DIR` if needed)

## Install

```bash
npm install -g @xyteai/cli@latest
xyte-cli --help
xyte-cli status --mode fast --output json
```

## First-Time Setup

Interactive:

```bash
xyte-cli setup run
```

Non-interactive:

```bash
XYTE_CLI_KEY="<your-key>" \
xyte-cli setup run --non-interactive --tenant acme
```

Check readiness:

```bash
xyte-cli setup status --tenant acme --output json
xyte-cli config doctor --tenant acme --output json
```

## Install Skills (Recommended)

```bash
xyte-cli init
```

Useful options:

```bash
xyte-cli init --no-setup
xyte-cli init --scope project --agents codex,claude
xyte-cli init --scope both --agents all --force
xyte-cli init --target /path/to/workspace
```

Default non-interactive behavior:

- scope: `project`
- agents: `all`

Install paths:

- Project scope:
  - Claude: `.claude/skills/xyte-cli`
  - Copilot: `.github/skills/xyte-cli`
  - Codex: `.agents/skills/xyte-cli`
- User scope:
  - Claude: `~/.claude/skills/xyte-cli`
  - Copilot: `~/.copilot/skills/xyte-cli`
  - Codex: `~/.agents/skills/xyte-cli`

## Skills-Less Operation

You can skip skill installation and drive everything directly from CLI help and command outputs.

```text
Use xyte-cli to inspect tenant acme and generate a PDF report.
Check xyte-cli --help first and keep outputs JSON when possible.
```
