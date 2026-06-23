# Getting Started

Built for shell-capable AI agents and automated terminal workflows.
Manual terminal use is supported for setup, debugging, and local testing.

## Requirements

- [Node.js 22+](https://nodejs.org/en/download) (npm/npx come with the Node.js install)
- A Xyte API key (create one in your tenant under **Settings → API Keys**)
- Writable local config directory (override with `XYTE_CLI_CONFIG_DIR` if needed)

If `node --version` is missing or below 22:

```sh
# macOS
brew install node@22

# Windows
winget install OpenJS.NodeJS.LTS
```

Other platforms: download from [nodejs.org](https://nodejs.org/en/download).

## Install

### AI agent

Use this path when Codex, Claude Code/Desktop, GitHub Copilot CLI, VS Code Copilot Agent, or another shell-capable agent is operating the terminal. Chat-only assistants can explain commands, but they cannot install the CLI.

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

If the report returns `"mode": "blocked"`, install Node.js 22+, preinstall `@xyteai/cli`, provide `xyte-cli` on `PATH`, or move to an environment with Node/npm and package network access.

Before you start: in Xyte, open **Settings → API Keys** and create a key. Save it in a plain text file outside your project folder (for example `xyte-api-key.txt` on your Desktop) — any text editor works. Your agent will ask for the file's path. Agents keep setup non-interactive (`--key-file`, `--key-stdin`, or `--key-command`). Do not paste API keys into chat. Do not store API keys inside the repo.

```sh
xyte-cli setup run --non-interactive --tenant acme --key-file <path-outside-workspace> --output json
xyte-cli setup status --tenant acme --field tenantId
```

`acme` is just a name for this connection — use your company name.

### CI / headless

1. In Xyte, open **Settings → API Keys** and create a key.
2. In your CI tool (GitHub Actions, GitLab CI, Jenkins), add a secret named `XYTE_CLI_KEY` and paste the key as its value.
3. Make sure the job receives the secret as an environment variable — in GitHub Actions add `env: XYTE_CLI_KEY: ${{ secrets.XYTE_CLI_KEY }}` to the step; GitLab CI passes variables automatically.
4. Add these commands to your pipeline (`acme` is just a name for this connection — use your company name):

```sh
npx -y @xyteai/cli@latest setup run --non-interactive --tenant acme --output json
npx -y @xyteai/cli@latest setup status --tenant acme --field tenantId
```

For reproducible pipelines, replace `@latest` with a pinned version (e.g. `@0.10.7`).

### Manual terminal

```sh
npm install -g @xyteai/cli@latest
xyte-cli --help
xyte-cli status --mode fast --output json
```

If your global npm bin is not on `PATH`, replace `xyte-cli` in the commands below with one of these published-package fallbacks:

```sh
npx -y @xyteai/cli@latest <command>
npm exec -- @xyteai/cli@latest <command>
```

## First-Time Setup

Create the API key first: in your Xyte tenant, open **Settings → API Keys** and create a key. Save it in a file outside your project folder (for example `~/.config/xyte/acme.key`), or paste it when the interactive prompt asks.

Interactive manual terminal setup:

```bash
xyte-cli setup run
```

The API key prompt hides input: paste the key, press Enter, and confirm the `Received <N> characters.` line matches your key length.

Non-interactive:

Primary automation contract:

Use `--key-file <path-outside-workspace>` when the key already lives on disk outside the repo, or pipe the API key on stdin into `xyte-cli setup run --non-interactive --tenant acme --key-stdin`. `--key-stdin` alone waits for stdin; it does not fetch a key by itself.

If the key lives in a secret manager, use `--key-command "<cmd>"`: xyte-cli runs the command, trims leading and trailing whitespace from stdout, and uses the result as the API key. The command must print only the key on stdout and exit 0.

Provider behavior:

- If `--provider` is omitted, setup validates `xyte-org` first and falls through to `xyte-partner`.
- If you run offline setup with `--connectivity never`, pass `--provider xyte-org|xyte-partner` explicitly.

Check readiness:

```bash
xyte-cli setup status --field tenantId
xyte-cli setup status --tenant acme --output json
xyte-cli config doctor --tenant acme --output json
```

Credential storage:

- Default persisted credential mode is `auth.secretStoreBackend=auto`.
- `auto` uses macOS Keychain on macOS, DPAPI on Windows, and Secret Service on Linux.
- If native secure storage is unavailable, `xyte-cli` warns and falls back to local file storage.
- Advanced override: `auth.secretStoreBackend=auto|native|file`.
- Require native secure storage: `xyte-cli config set auth.secretStoreBackend native`
- Use file storage intentionally: `xyte-cli config set auth.secretStoreBackend file`
- `xyte-cli config path --output json` reports `secretStoreBackend`, `secretStore`, and `legacySecretStore`. `secretStore` is the effective location for the selected backend: a filesystem path when `secretStoreBackend` is `file`, and the service name used in the OS keychain (e.g. `xyte-cli`) when it is `keychain`, `dpapi`, or `secret-service`.

Shell-specific non-interactive examples:

PowerShell:

```powershell
Get-Content <path-outside-workspace> | xyte-cli setup run --non-interactive --tenant acme --key-stdin
```

CMD:

```bat
type <path-outside-workspace> | xyte-cli setup run --non-interactive --tenant acme --key-stdin
```

Bash/zsh:

```bash
<secret-command> | xyte-cli setup run --non-interactive --tenant acme --key-stdin
```

Key file:

```bash
xyte-cli setup run --non-interactive --tenant acme --key-file ~/.config/xyte/acme.key
```

Secret manager via `--key-command`:

```bash
# 1Password
xyte-cli setup run --non-interactive --tenant acme --key-command "op read op://Employee/Xyte/credential"

# HashiCorp Vault
xyte-cli setup run --non-interactive --tenant acme --key-command "vault kv get -field=key secret/xyte"

# AWS Secrets Manager
xyte-cli setup run --non-interactive --tenant acme --key-command "aws secretsmanager get-secret-value --secret-id xyte --query SecretString --output text"

# pass (the standard Unix password manager)
xyte-cli setup run --non-interactive --tenant acme --key-command "pass show xyte/api-key"
```

Authenticate the secret manager before running xyte-cli (e.g. `eval $(op signin)` or `vault login`). Make sure the command prints only the key on stdout — extra lines or banners will be trimmed only at the edges.

Offline example:

```bash
printf '%s\n' '<your-key>' | xyte-cli setup run --non-interactive --tenant acme --provider xyte-org --key-stdin --connectivity never
```

## Install Skills (Recommended)

```bash
xyte-cli init --no-setup
```

Useful options:

```bash
xyte-cli init --no-setup
xyte-cli init --scope project --agents codex,claude --no-setup
xyte-cli init --scope both --agents all --force --no-setup
xyte-cli init --target /path/to/workspace --no-setup
```

After upgrading the CLI, refresh installed bundles (upgrade only refreshes user scope automatically):

```bash
xyte-cli skills refresh
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

## Claim Devices (Native, Edge, C2C)

See [`claim-devices.md`](claim-devices.md) for the full native-vs-edge-vs-C2C decision guide. Two rules up front:

- **Ask first.** When the path isn't explicit, ask which of native / edge / C2C applies; do not auto-pick from spreadsheet columns.
- **C2C is not available** via the public API today — use the End Customer Portal.

One-liners:

```bash
# Native / direct (sn + mac + cloud_id known):
xyte-cli api call organization.devices.claimDevice --tenant <tenant-id> --body-json '{"name":"<name>","space_id":<space-id>,"sn":"<sn>","mac":"<mac>","cloud_id":"<cloud-id>"}'

# Edge (behind an Xyte Edge proxy):
xyte-cli edge models --tenant <tenant-id> --search <model-search>
xyte-cli edge model --tenant <tenant-id> <model-id>
xyte-cli edge claim --tenant <tenant-id> --proxy-id <proxy-id> --device-ip <ip> --device-model-id <model-id> --space-id <space-id> --plan

# Bulk edge (blank skip_connectivity_check rows ping before claim):
xyte-cli util prepare --action organization.edge.startClaim --input ./edge-devices.xlsx --output-dir ./prepared
xyte-cli edge claim-batch --tenant <tenant-id> --input ./prepared/organization-edge-startclaim.csv --report ./artifacts/edge-claim-report.ndjson --plan
```

## Skills-Less Operation

You can skip skill installation and drive everything directly from CLI help and command outputs.

```text
Use xyte-cli to inspect tenant acme and generate a PDF report.
Check xyte-cli --help first and keep outputs JSON when possible.
```
