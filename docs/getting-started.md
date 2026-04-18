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
- `xyte-cli config path --format json` reports `secretStoreBackend`, `secretStore`, and `legacySecretStore`. `secretStore` is the effective location for the selected backend: a filesystem path when `secretStoreBackend` is `file`, and the service name used in the OS keychain (e.g. `xyte-cli`) when it is `keychain`, `dpapi`, or `secret-service`.

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

## Claim Devices (Native, Edge, C2C)

See [`claim-devices.md`](claim-devices.md) for the full native-vs-edge-vs-C2C decision guide. Two rules up front:

- **Ask first.** When the path isn't explicit, ask which of native / edge / C2C applies; do not auto-pick from spreadsheet columns.
- **C2C is not available** via the public API today — use the End Customer Portal.

One-liners:

```bash
# Native / direct (sn + mac + cloud_id known):
xyte-cli api call organization.devices.claimDevice --tenant <tenant-id> --body-json '{"name":"<name>","space_id":<space-id>,"sn":"<sn>","mac":"<mac>","cloud_id":"<cloud-id>"}'

# Edge (behind an Xyte Edge proxy):
xyte-cli edge claim --tenant <tenant-id> --proxy-id <proxy-id> --device-ip <ip> --device-model-id <model-id> --space-id <space-id> --apply

# Bulk edge:
xyte-cli util prepare --action organization.edge.startClaim --input ./edge-devices.xlsx --output-dir ./prepared
xyte-cli edge claim-batch --tenant <tenant-id> --input ./prepared/organization-edge-startclaim.csv --report ./artifacts/edge-claim-report.ndjson --apply
```

## Skills-Less Operation

You can skip skill installation and drive everything directly from CLI help and command outputs.

```text
Use xyte-cli to inspect tenant acme and generate a PDF report.
Check xyte-cli --help first and keep outputs JSON when possible.
```
