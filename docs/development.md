# Development

## Local Validation Loop

```bash
npm ci
npm run typecheck
npm test
npm run build
npm pack
npm run release:check
```

## Commit Gate (Fresh External User Flow)

```bash
npm run test:commit
```

`test:commit` runs:

1. `npm run typecheck`
2. `npm test`
3. `npm run smoke:pack-install`

Native secure-storage certification runs separately in CI via `windows-native-secret-store-cert` and `linux-native-secret-store-cert`.

## Local Utility Sandbox

Terminal A:

```bash
npm run mock:xyte:local -- --port 3001
```

Terminal B:

```bash
npm run smoke:local:utilities -- --base-url http://127.0.0.1:3001 --tenant local
```

## Local Flow-Pack Smoke

Runs build/test + flow-pack command coverage against a local tenant and emits a readable per-step summary.
Expected write and destructive calls are treated as direct execution paths in smoke coverage.

```bash
npm run smoke:local:flow-pack -- --tenant local3000
```

## Controlled Upgrade Docker Smoke

```bash
npm run smoke:upgrade:controlled
```

This builds tarball A/B from the current package, runs a clean Docker environment, installs A, upgrades to B via `xyte-cli upgrade`, refreshes user-scope skills, and validates direct write/dry endpoint behavior against the local mock server.

## Release

See [`release.md`](release.md) for publish and release-asset workflows.

## Manual Check: Interactive Logs Viewer

```bash
xyte-cli --log-actions --log-actions-path ./logs/xyte-cli.actions.ndjson status --tenant acme
xyte-cli logs list --path ./logs/xyte-cli.actions.ndjson --output text
xyte-cli logs show --path ./logs/xyte-cli.actions.ndjson --entry <sessionId>:<seq> --output json
xyte-cli logs view --path ./logs/xyte-cli.actions.ndjson
```

Quick verification:

- Press `↑/↓`: selected row changes and details pane updates.
- Press `Tab`: focus switches between list/details panes.
- Press `PageUp/PageDown` on details pane: details scroll.
- Press `q`: viewer exits and shell prompt returns cleanly.
