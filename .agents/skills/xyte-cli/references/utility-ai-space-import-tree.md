# Utility AI Node: Space Import Tree Decode

Use this node only when the target action is `space.import-tree`.

## Objective

Decode a messy source hierarchy into canonical space-import artifacts for `xyte-cli`.

## Canonical Output Artifacts

1. Primary CSV:
- `/Users/porton/Projects/xyte-cli/tmp/space-import-tree.csv`
- exact header:
  - `path,space_type,config`

2. Rejected CSV:
- `/Users/porton/Projects/xyte-cli/tmp/space-import-tree.rejected.csv`
- include original row/object and `reject_reason`

3. Notes:
- `/Users/porton/Projects/xyte-cli/tmp/space-import-tree.notes.md`
- include normalization assumptions and ambiguity handling

## Decode Rules

1. `path` must be non-empty.
2. Normalize separators to `/`.
3. Trim whitespace around each path segment.
4. Do not infer missing hierarchy segments.
5. Put ambiguous rows in rejected output with `reject_reason`.
6. `config` must be an object (or valid JSON string that parses to object).

## Execution Sequence

Decision gate (required):
- After files are structured, ask user: `Run dry-run, apply, or stop?`
- Never auto-run apply without explicit user choice.

Dry-run:

```bash
xyte-cli space import-tree \
  --tenant <tenant-id> \
  --input /Users/porton/Projects/xyte-cli/tmp/space-import-tree.csv \
  --report /Users/porton/Projects/xyte-cli/tmp/space-import-tree.dryrun.ndjson
```

Apply:

```bash
xyte-cli space import-tree \
  --tenant <tenant-id> \
  --input /Users/porton/Projects/xyte-cli/tmp/space-import-tree.csv \
  --apply \
  --report /Users/porton/Projects/xyte-cli/tmp/space-import-tree.apply.ndjson
```

Verify:

```bash
xyte-cli call organization.spaces.getSpaces \
  --tenant <tenant-id> \
  --query-json '{"path_includes":"<sample-path>"}'
```
