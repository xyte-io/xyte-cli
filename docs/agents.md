# Agent Usage

Built for shell-capable AI agents and automated terminal workflows.
Manual terminal use is supported for setup, debugging, and local testing.

## Fast Path

Use an agent surface that can execute shell commands: Codex, Claude Code/Desktop, GitHub Copilot CLI, VS Code Copilot Agent, or another shell-capable agent. Chat-only assistants can explain commands, but they cannot install the CLI.

1. Start with environment diagnostics. The report picks the right install mode and returns copy-pasteable commands in `recommendations`:

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
./.xyte-cli/runtime/node_modules/.bin/xyte-cli doctor environment --format json
```

PowerShell command path:

```powershell
.\.xyte-cli\runtime\node_modules\.bin\xyte-cli.cmd doctor environment --format json
```

2. Create an API key in Xyte under **Settings → API Keys** and save it in a plain text file outside the workspace. Use the report's command prefix for non-interactive setup. Do not paste API keys into chat. Do not store API keys inside the repo.

```sh
xyte-cli setup run --non-interactive --tenant <tenant-id> --key-file <path-outside-workspace> --output json
xyte-cli setup status --tenant <tenant-id> --field tenantId
```

3. Install the skill bundle once in your workspace:

```sh
xyte-cli init --scope project --agents all --force --no-setup
```

## Agent Prompt

Before you start: in Xyte, open **Settings → API Keys** and create a key. Save it in a plain text file outside your project folder (for example `xyte-api-key.txt` on your Desktop) — any text editor works. Your agent will ask for the file's path.

Copy this into a shell-capable agent:

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

## Flow-First Agent Operations

Prefer one deterministic command over multi-step ad-hoc orchestration:

```bash
xyte-cli flow list --format text
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

## Claim-Device Agent Rules

When a prompt includes "claim device(s)" without specifying the path, the agent MUST:

1. Ask the user whether they mean native / direct (`organization.devices.claimDevice`) or edge (`organization.edge.startClaim`).
2. Note that Cloud-to-Cloud (C2C) claiming is not available via the public API today — point the user to the End Customer Portal.
3. For Edge claims, run `xyte-cli edge models` / `xyte-cli edge model <id>` first and use the returned `parameters[].name` keys for `custom_parameters`; never guess required model fields.
4. Only then run the matching command or flow (`xyte-cli edge claim`, `xyte-cli edge claim-batch`, `xyte-cli flow run flow.edge-claim*`).

Full playbook for the agent: skill reference `references/claim-playbook.md`. User-facing tutorial: [`claim-devices.md`](claim-devices.md).

## Agent-Specific Notes

### Claude

Claude Code (terminal CLI or desktop app) is shell-capable. Claude chat on the web is not.

```sh
xyte-cli init --no-setup
claude
# paste the agent prompt from this doc
```

### Codex

The Codex CLI and IDE integrations are shell-capable. ChatGPT chat without Codex is not.

```sh
xyte-cli init --no-setup
# paste the agent prompt from this doc into Codex
```

### GitHub Copilot

The Copilot surface that can run commands is VS Code Copilot in **Agent mode** (switch the chat panel picker from "Ask" to "Agent") or GitHub Copilot CLI in a terminal. Copilot Chat surfaces only explain commands. For Copilot cloud agents, preinstall Node.js 22+ and `@xyteai/cli` in `.github/workflows/copilot-setup-steps.yml` when the environment does not already provide them.

```sh
xyte-cli init --no-setup
# paste the agent prompt from this doc into Copilot Agent mode
```

## Skills-Less Mode

Skills are optional. Agents can work directly from CLI help and command outputs.
