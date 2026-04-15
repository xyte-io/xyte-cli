# Getting Started

## Requirements

- Node.js 22+
- A valid Xyte API key
- Writable local config directory (override with `XYTE_CLI_CONFIG_DIR` if needed)

## Install

```bash
npm install -g @xyteai/cli@latest
xyte-cli --help
xyte-cli status --mode fast --output json
```

If your global npm bin is not on `PATH`, replace `xyte-cli` in the commands below with one of these published-package fallbacks:

```bash
npx @xyteai/cli@latest <command>
npm exec -- @xyteai/cli@latest <command>
```

## First-Time Setup

Interactive:

```bash
xyte-cli setup run
```

Non-interactive:

Primary automation contract:

Use `--key-file <path>` when the key already lives on disk, or pipe the API key on stdin into `xyte-cli setup run --non-interactive --tenant acme --key-stdin`. `--key-stdin` alone waits for stdin; it does not fetch a key by itself.

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
- `xyte-cli config path --format json` reports `secretStoreBackend`, `secretStore`, and `legacySecretStore`. `secretStore` may be a backend identifier such as `xyte-cli`, not only a filesystem path.

Shell-specific non-interactive examples:

PowerShell:

```powershell
"<your-key>" | xyte-cli setup run --non-interactive --tenant acme --key-stdin
```

CMD:

```bat
echo <your-key>| xyte-cli setup run --non-interactive --tenant acme --key-stdin
```

Bash/zsh:

```bash
printf '%s\n' '<your-key>' | xyte-cli setup run --non-interactive --tenant acme --key-stdin
```

Key file:

```bash
xyte-cli setup run --non-interactive --tenant acme --key-file ~/.config/xyte/acme.key
```

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
