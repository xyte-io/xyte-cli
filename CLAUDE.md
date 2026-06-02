# xyte-cli

Repository guidance for Claude Code and other coding agents working in this repo.

## Product Shape

- Package: `@xyteai/cli`
- Runtime: Node.js 22+; the package is CommonJS TypeScript built to `dist/`.
- Purpose: deterministic Xyte operations for humans and agents through `xyte-cli`.
- Main surfaces: CLI commands, TUI/headless console views, raw API calls, guided flows, utility preprocessing, packaged skills, docs, and JSON schemas.
- This repo does not expose an MCP server; `xyte-cli mcp serve` is intentionally not registered.

## Layout

- `src/bin/xyte-cli.ts` - executable entrypoint.
- `src/cli/` - Commander command registration and command implementations.
- `src/client/` - endpoint catalog access, typed namespaces, and HTTP client.
- `src/api-catalog/` - public endpoint catalog and verified drift overrides.
- `src/workflows/` - reusable flow, edge, utility, report, and ops workflows.
- `src/tui/` - interactive and headless TUI runtime/screens.
- `docs/` - command docs, guides, schemas, and GitHub Pages content.
- `skills/xyte-cli/` - shipped agent skill bundle copied by `xyte-cli init`.
- `tests/` - Vitest unit, contract, CLI, TUI, workflow, and smoke tests.
- `scripts/` - build, sync, release, mock server, and smoke helpers.

## Public Commands

Common command groups currently include:

- `init` - install project/user agent skill files and optionally run setup.
- `setup` - first-time tenant/key setup and readiness checks.
- `config` - tenant, key slot, settings, and diagnostics management.
- `api` - endpoint discovery and raw endpoint calls.
- `ops` - incident watch, fleet/deep-dive inspection, reports, and console snapshots.
- `util` - prepare/import helper workflows.
- `edge` - edge claim/ping workflows.
- `flow` - built-in and user-defined workflow discovery/execution.
- `logs`, `status`, `doctor`, `upgrade` - local operations and diagnostics.

Do not document or reintroduce removed wrapper commands such as `xyte-cli install --skills`.
Use `xyte-cli init --no-setup` for skill installation examples.

## External Calls And Credentials

- API calls target Xyte Hub/Entry REST endpoints from `src/api-catalog/public-endpoints.json`.
- Auth uses tenant-bound organization and partner API keys.
- Default credential storage is `auth.secretStoreBackend=auto`: macOS Keychain, Windows DPAPI, or Linux Secret Service, with file fallback when native storage is unavailable.
- Override credential backend with `XYTE_CLI_SECRET_STORE_BACKEND=auto|native|file` or the matching config setting.
- Use `XYTE_CLI_CONFIG_DIR` to isolate config during tests or local experiments.
- Never print secrets. Prefer `--key-file`, `--key-stdin`, or `--key-command` over inline keys.

## Development Commands

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run smoke:pack-install
```

Useful focused commands:

```bash
npm run skills:sync
npm test -- tests/endpoints.test.ts tests/namespaces.test.ts tests/skills-sync.test.ts
npm run release:check
```

`npm run build` runs `clean`, syncs shipped skill endpoint data, and builds with `tsconfig.build.json`.
When `src/api-catalog/public-endpoints.json` changes, run `npm run skills:sync` and keep `skills/xyte-cli/data/public-endpoints.json` byte-identical.

## Coding Rules

- Make surgical changes. Every changed line should trace to the requested task.
- Prefer existing local helpers, command patterns, schemas, and workflow contracts.
- Do not add compatibility aliases, hidden fallback routes, or broader behavior unless explicitly requested.
- Do not invent endpoint facts. Verify route, method, auth scope, path params, query params, and body behavior before exposing an endpoint.
- Raw API mutating calls execute directly; do not document legacy `--allow-write` or endpoint-level `--confirm` flags for `api call`.
- Destructive local config commands such as tenant/key removal still require their explicit `--confirm` flags.
- TUI writes require token confirmation through the TUI confirmation helpers.
- Keep JSON/headless contracts schema-versioned. Schema changes are compatibility-boundary changes.
- Tests should avoid live network calls unless a smoke command is explicitly designed for live verification and gated by env vars.

## PR Readiness Checklist

- Check mergeability against current `main`; stale docs-only PRs can still conflict.
- For endpoint/catalog work, update catalog, shipped skill data, client namespace, docs/skills, tests, and package contents together.
- For docs-only work, verify examples name real commands and current package/runtime details.
- Run the narrowest meaningful tests first, then the broader gate appropriate for the touched surface.
