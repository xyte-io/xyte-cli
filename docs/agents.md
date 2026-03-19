# Agent Usage

## Fast Path

1. Install skill bundle once in your workspace:

```bash
xyte-cli init
```

If your global npm bin is not on `PATH`, replace `xyte-cli` in the commands below with:

```bash
npx @xyteai/cli@latest <command>
npm exec @xyteai/cli@latest -- <command>
```

2. Prompt your coding agent to run `xyte-cli` commands directly.

Example prompt:

```text
Inspect tenant acme and generate a report.
Use xyte-cli commands directly and keep outputs JSON-first.
```

## Flow-First Agent Operations

Prefer one deterministic command over multi-step ad-hoc orchestration:

```bash
xyte-cli flow list
xyte-cli flow run <flow-id> --tenant <tenant-id> --plan
```

For custom aliases and pinned defaults:

```bash
xyte-cli flow create flow.<team-name> --based-on <built-in-flow-id> --var key=value
xyte-cli flow edit flow.<team-name> --var key=value
xyte-cli flow share flow.<team-name> --out ./artifacts/flow.<team-name>.json
xyte-cli flow import --file ./artifacts/flow.<team-name>.json
```

Detailed workflow authoring guide:
- [`flows/custom-workflows.md`](flows/custom-workflows.md)

## Agent-Specific Notes

### Claude

```bash
xyte-cli init
claude
```

### Codex

```bash
xyte-cli init
# in prompts, ask Codex to run xyte-cli commands directly
```

### GitHub Copilot

```bash
xyte-cli init
# in prompts, ask Copilot to run xyte-cli commands directly
```

## Skills-Less Mode

Skills are optional. Agents can work directly from CLI help and command outputs.
