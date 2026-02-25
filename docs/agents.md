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
