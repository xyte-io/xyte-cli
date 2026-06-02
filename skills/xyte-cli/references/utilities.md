# Util Prepare Flows (Preprocess-First)

`xyte-cli` util preprocessing is auth-agnostic. It creates structured files only.

References:
1. `references/ai-utility-preprocessing.md`
2. `templates/ai-utility-prepare-generic.prompt.md`
3. `templates/ai-space-import.prompt.md`

## Safety Defaults

1. Always run preprocessing first.
2. Review the generated `.notes.md` file; it is the column glossary, required/optional guide, reject taxonomy, canonical JSON shape, and safe-command checklist.
3. After files are generated, ask the user what to do next.
4. Never auto-run `--apply`.

## SOP A: Bulk Claim Preprocessing (`organization.devices.claimDevice`)

```bash
xyte-cli util prepare \
  --action organization.devices.claimDevice \
  --input /path/to/raw-source.xlsx \
  --tenant <tenant-id> \
  --output-dir ./prepared \
  [--primary-format csv|jsonl] [--force]
```

Expected files:
1. `./prepared/organization-devices-claimdevice.csv`
2. `./prepared/organization-devices-claimdevice.rejected.csv`
3. `./prepared/organization-devices-claimdevice.notes.md`

Decision gate:
1. Validate each target `space_id` with `organization.spaces.getSpace` before write loops.
2. Run a single probe claim with `--output-mode envelope`; if upstream returns `No device found`, stop bulk claim writes.
3. Ask the user whether to execute this action via an `xyte-cli api call` loop or stop.

## SOP A2: Bulk Edge Claim Preprocessing + Execution (`organization.edge.startClaim`)

Scope check first: edge claim is for devices **behind an Xyte Edge proxy** identified by IP + device model id. For devices on the same network as the platform with known sn/mac/cloud_id, use SOP A (native claim) instead. If the user mentions Cloud-to-Cloud (C2C), tell them the public API does not expose C2C claiming — point to the End Customer Portal. Full disambiguation guidance: `references/claim-playbook.md`.

Prepare:

```bash
xyte-cli util prepare \
  --action organization.edge.startClaim \
  --input /path/to/edge-devices.xlsx \
  --tenant <tenant-id> \
  --output-dir ./prepared
```

Expected files:
1. `./prepared/organization-edge-startclaim.csv` — rows ready for `edge claim-batch`; blank `skip_connectivity_check` means the batch will ping before claim.
2. `./prepared/organization-edge-startclaim.rejected.csv` — rows with `reject_reason` (missing `proxy_id`, malformed `device_ip`, non-numeric `space_id`, etc.).
3. `./prepared/organization-edge-startclaim.notes.md` — column glossary + action taxonomy.

Dry-run (`--plan`) — zero API calls, per-row intended action:

```bash
xyte-cli edge claim-batch \
  --tenant <tenant-id> \
  --input ./prepared/organization-edge-startclaim.csv \
  --report ./artifacts/edge-claim-report.ndjson \
  --plan
```

Apply — only after explicit user approval:

```bash
xyte-cli edge claim-batch \
  --tenant <tenant-id> \
  --input ./prepared/organization-edge-startclaim.csv \
  --report ./artifacts/edge-claim-report.ndjson \
  --resume-artifact ./artifacts/edge-claim.resume.ndjson \
  --apply
```

Resume after interruption:

```bash
xyte-cli edge claim-batch \
  --tenant <tenant-id> \
  --input ./prepared/organization-edge-startclaim.csv \
  --report ./artifacts/edge-claim-report.ndjson \
  --resume-artifact ./artifacts/edge-claim.resume.ndjson \
  --apply
```

Resume uses completed row dispositions from `--resume-artifact`; it does not checkpoint in-flight claim IDs. If the process dies after `startClaim` but before a row result is written, inspect `edge claim-status` / logs before rerunning that row.

Decision gate:
1. Populate `organization-edge-startclaim.csv` from the source material before running `--plan`.
2. Review `organization-edge-startclaim.rejected.csv` before running `--plan`.
3. Review `edge-claim-report.ndjson` after `--plan`; confirm zero unexpected rejections.
4. Ask the user before running `--apply`.
5. On partial batch failure (exit 1), re-run with `--resume-artifact`.
6. Use row `skip_connectivity_check=true` or command `--skip-connectivity-check` only when the batch should skip its internal pre-claim ping.

Artifact split:
1. stdout carries the `xyte.edge.claim-batch.v1` summary.
2. `--report` writes per-row audit NDJSON for review/debugging.
3. `--resume-artifact` writes completed row resume state for partial-run continuation.

Full edge-case matrix and terminal-state handling: `references/claim-playbook.md`.

## SOP B: Space Import Preprocessing + Execution (`space.import-tree`)

Prepare:

```bash
xyte-cli util prepare \
  --action space.import-tree \
  --input /path/to/raw-hierarchy.pdf \
  --tenant <tenant-id> \
  --output-dir ./prepared
```

Dry-run:

```bash
xyte-cli util import-tree \
  --tenant <tenant-id> \
  --input ./prepared/space-import-tree.csv \
  [--input-format auto|csv|json|jsonl] [--path-field <name>] [--space-type-field <name>] [--config-field <name>] \
  [--continue-on-error] \
  --report ./artifacts/space-import-tree.dryrun.ndjson
```

Dry-run summaries report validated rows as `totals.planned`; `totals.succeeded` is reserved for apply mode.

Apply:

```bash
xyte-cli util import-tree \
  --tenant <tenant-id> \
  --input ./prepared/space-import-tree.csv \
  --apply \
  --report ./artifacts/space-import-tree.apply.ndjson
```

Verify:

```bash
xyte-cli api call organization.spaces.getSpaces \
  --tenant <tenant-id> \
  --query-json '{"path_includes":"HQ/Floor 1/Office 1"}'
```

## SOP B2: Connector Setup Normalization (`organization.connectors.prepareSetup`)

Prepare:

```bash
xyte-cli util prepare \
  --action organization.connectors.prepareSetup \
  --input /path/to/connectors-rough.csv \
  --tenant <tenant-id> \
  --output-dir ./prepared
```

Expected files:
1. `./prepared/organization-connectors-preparesetup.csv`
2. `./prepared/organization-connectors-preparesetup.rejected.csv`
3. `./prepared/organization-connectors-preparesetup.notes.md`

Primary headers:
`label,platform,connectorName,targetSpace,targetSpaceId,authorizationOwner,deviceNameSource,sourceRow,notes`

Rules:
1. `connectorName` must be supported by the generated notes.
2. `targetSpace` is required.
3. `authorizationOwner` is required.
4. `targetSpaceId` stays blank unless the source explicitly contains a real id.
5. `deviceNameSource` defaults to `xyte_managed` when absent.
6. This is prepare-only; do not run an API call from this utility output.

## SOP B3: Team Access Normalization (`organization.teamAccess.*`)

Run one prepare action per artifact:

```bash
xyte-cli util prepare \
  --action organization.teamAccess.groups \
  --input /path/to/team-rough.csv \
  --tenant <tenant-id> \
  --output-dir ./prepared

xyte-cli util prepare \
  --action organization.teamAccess.users \
  --input /path/to/team-rough.csv \
  --tenant <tenant-id> \
  --output-dir ./prepared

xyte-cli util prepare \
  --action organization.teamAccess.memberships \
  --input /path/to/team-rough.csv \
  --tenant <tenant-id> \
  --output-dir ./prepared
```

Expected group files:
1. `./prepared/organization-teamaccess-groups.csv`
2. `./prepared/organization-teamaccess-groups.rejected.csv`
3. `./prepared/organization-teamaccess-groups.notes.md`

Group headers:
`label,groupName,iconName,sourceRow,notes`

Expected user files:
1. `./prepared/organization-teamaccess-users.csv`
2. `./prepared/organization-teamaccess-users.rejected.csv`
3. `./prepared/organization-teamaccess-users.notes.md`

User headers:
`label,email,name,groupName,assignSupportSeat,sourceRow,notes`

Expected membership files:
1. `./prepared/organization-teamaccess-memberships.csv`
2. `./prepared/organization-teamaccess-memberships.rejected.csv`
3. `./prepared/organization-teamaccess-memberships.notes.md`

Membership headers:
`label,email,groupName,sourceRow,notes`

Rules:
1. Groups require `groupName`; `iconName` defaults to `users`.
2. Users require `email`; do not invent emails.
3. Memberships require `email` and `groupName`.
4. If one source row creates a user and assigns a group, prepare both users and memberships outputs through their separate utilities.
5. These are prepare-only; do not run API calls from these utility outputs.

## SOP C: Device-to-Space Matching (`util match`)

```bash
xyte-cli util match \
  --source ./artifacts/source-devices.json \
  --target ./artifacts/target-spaces.json \
  --source-field name \
  --target-field name \
  --out ./artifacts/device-moves.csv \
  --tenant <tenant-id>
```

Expected files:
1. `./artifacts/device-moves.csv` — deterministic move mapping (device_id, source_space_id, target_space_id).
2. `./artifacts/device-moves.csv.summary.json` — match statistics sidecar.

Decision gate:
1. Review the summary JSON for match/unmatched counts.
2. Inspect the CSV for correctness before proceeding to `util move-devices`.

## SOP D: Batch Device Move (`util move-devices`)

Dry-run:

```bash
xyte-cli util move-devices \
  --tenant <tenant-id> \
  --input ./artifacts/device-moves.csv \
  --report ./artifacts/device-migration.dry-run.ndjson
```

Dry-run summaries report validated rows as `totals.planned`; `totals.succeeded` is reserved for apply mode.

Apply:

```bash
xyte-cli util move-devices \
  --tenant <tenant-id> \
  --input ./artifacts/device-moves.csv \
  --apply \
  --report ./artifacts/device-migration.apply.ndjson
```

Additional options:
- `--input-format auto|csv|json|jsonl` — override input format detection.
- `--continue-on-error` — continue processing rows after individual failures.

Decision gate:
1. Always dry-run first without `--apply`.
2. Review the NDJSON row report for failed or skipped rows.
3. Ask the user whether to execute with `--apply` or stop.

## SOP E: Generic Endpoint Preprocessing

List actions:

```bash
xyte-cli util list-actions --output text --mode friendly
xyte-cli util list-actions --output text --execution-support edge.claim-batch
```

Prepare generic action:

```bash
xyte-cli util prepare \
  --action organization.tickets.updateTicket \
  --input /path/to/raw-ticket-updates.csv \
  --tenant <tenant-id> \
  --output-dir ./prepared
```

Generic canonical headers:
1. `<path params in order>,query_json,body_json`
