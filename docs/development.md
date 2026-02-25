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
XYTE_CLI_KEY="<real-key>" \
XYTE_E2E_TENANT="<tenant-id-or-default>" \
npm run test:commit
```

`test:commit` runs:

1. `npm run typecheck`
2. `npm test`
3. `npm run smoke:external-live`

If `XYTE_E2E_TENANT` is omitted, `default` is used.
If `XYTE_CLI_KEY` is missing, smoke fails before install calls.

## Local Utility Sandbox

Terminal A:

```bash
npm run mock:xyte:local -- --port 3001
```

Terminal B:

```bash
npm run smoke:local:utilities -- --base-url http://127.0.0.1:3001 --tenant local
```

## Controlled Upgrade Docker Smoke

```bash
npm run smoke:upgrade:controlled
```

This builds tarball A/B from the current package, runs a clean Docker environment, installs A, upgrades to B via `xyte-cli upgrade`, refreshes user-scope skills, and validates guarded/dry endpoint behavior against the local mock server.

## Release

See [`release.md`](release.md) for publish and release-asset workflows.
