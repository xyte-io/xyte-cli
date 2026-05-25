# xyte-cli

**Stack:** Node.js 18+ (TypeScript), Vitest, distributed as `@xyte/cli`
**Purpose:** CLI + TUI + MCP server for the Xyte hub API. Built for coding agents and operators: deterministic commands, headless NDJSON snapshots, guarded writes/deletes, and an installable "skills" pack for downstream agents.

## Layout

- `src/` — TypeScript source (CLI commands, TUI screens, MCP server, headless reporters).
- `bin/` — package entry.
- `skills/` — installable skills surfaced via `xyte-cli install --skills`.
- `tests/` — Vitest specs.
- `docs/` — developer-facing docs.
- `dist/` — build output (not source).

## What this repo exposes

- A **global CLI** (`xyte-cli ...`) installed via `npm install -g @xyte/cli`.
- An **MCP server** (`xyte-cli mcp serve`) usable from any MCP-aware client.
- **Skills bundle** for coding agents (installed by `xyte-cli install --skills`).

## What this repo calls

- **hub** REST API. Authenticates with user-supplied API keys stored in the OS keychain (macOS Keychain / Linux `secret-tool`, with a `memory` backend for tests via `XYTE_CLI_KEYCHAIN_BACKEND=memory`).

## Run / test / lint

```bash
npm install
npm run build
npm test                 # vitest
npx tsc -p tsconfig.json # typecheck (build uses tsconfig.build.json)
```

## Conventions

- **Guarded writes**: any endpoint that mutates needs `--allow-write`; deletes additionally need `--confirm <endpoint-key>`. Preserve these flags when adding new commands — don't bypass them for "convenience".
- **Stable headless contracts**: `--json` / NDJSON output is schema-versioned. Changes to that output are breaking API changes for downstream agents — bump the schema version intentionally.
- **No network in tests** — use the keychain `memory` backend and mock HTTP.
- TUI screens live under `src/` organized by screen name (`setup`, `config`, `dashboard`, `spaces`, `devices`, `incidents`, `tickets`).
