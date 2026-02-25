# Agent Usage

## Fast Path

1. Install skill bundle once in your workspace:

```bash
xyte-cli install --skills
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
xyte-cli flow share flow.<team-name> --out ./tmp/flow.<team-name>.json
xyte-cli flow import --file ./tmp/flow.<team-name>.json
```

Detailed workflow authoring guide:
- [`flows/custom-workflows.md`](flows/custom-workflows.md)

## Agent-Specific Notes

### Claude

```bash
xyte-cli install --skills
claude
```

### Codex

```bash
xyte-cli install --skills
# in prompts, ask Codex to run xyte-cli commands directly
```

### GitHub Copilot

```bash
xyte-cli install --skills
# in prompts, ask Copilot to run xyte-cli commands directly
```

## Skills-Less Mode

Skills are optional. Agents can work directly from CLI help and command outputs.
