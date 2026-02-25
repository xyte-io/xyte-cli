# Delta Watch V1 Plan (Implemented)

## Command Contract

```bash
xyte-cli watch --tenant <tenant-id> \
  [--profile incidents-active] \
  [--query-json '{"status":"active"}'] \
  [--interval-ms 2000] \
  [--max-polls 2] \
  [--once] \
  [--strict-json]
```

- Default profile: `incidents-active`
- Default run mode: continuous
- `--once` forces single-poll execution
- Default interval: `2000ms`
- Minimum interval: `250ms`
- Endpoint: `organization.incidents.getIncidents`

## Output Contract

Schema version: `xyte.watch.frame.v1`

Frame fields:
- `schemaVersion`
- `timestamp`
- `runId`
- `sequence`
- `pollIndex`
- `intervalMs`
- `profile`
- `endpointKey`
- `tenantId` (optional)
- `eventType` (`snapshot|delta|heartbeat|error`)
- `query`
- `summary`
- `items` (snapshot only)
- `delta` (delta only)
- `error` (error only)

## Acceptance Cases

1. `watch --once` emits one `snapshot` frame and exits `0`.
2. `watch --max-polls 2` + unchanged data emits `snapshot` then `heartbeat`.
3. `watch --max-polls 2` + changed second poll emits `snapshot` then `delta`.
4. Poll errors emit an `error` frame and keep previous baseline.
5. `--interval-ms < 250` fails with a clear validation error.
6. Contract tests validate `xyte.watch.frame.v1` schema.
7. Golden test normalizes volatile fields deterministically.
