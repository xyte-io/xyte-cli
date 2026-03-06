# Custom Workflow Authoring

Use custom flows when you want a stable alias with prefilled defaults for your tenant/team.

Custom flows do not define new step graphs. They alias one built-in flow and pin default context values.

## Quick Start

List built-in flow IDs:

```bash
xyte-cli flow list
```

Create a custom flow:

```bash
xyte-cli flow create flow.local-watch-triage \
  --based-on flow.watch-to-triage \
  --title "Local Watch Triage" \
  --description "Local tenant triage loop" \
  --var window_hours=12
```

Run safely in plan mode:

```bash
xyte-cli flow run flow.local-watch-triage --tenant <tenant-id> --plan
```

## Add A Workflow (Create)

Custom flow IDs should be stable and team-scoped. Recommended format:

- `flow.<team>-<intent>`

Examples:

```bash
xyte-cli flow create flow.noc-watch-triage \
  --based-on flow.watch-to-triage \
  --title "NOC Watch Triage" \
  --description "NOC incident triage alias" \
  --var window_hours=12
```

```bash
xyte-cli flow create flow.ops-guided-remediation \
  --based-on flow.guided-remediation \
  --var device_id=<device-id> \
  --var incident_id=<incident-id> \
  --var ticket_id=<ticket-id>
```

## Edit Defaults And Metadata

Merge new defaults into existing defaults:

```bash
xyte-cli flow edit flow.local-watch-triage \
  --description "Handoff triage flow for local NOC" \
  --var region=us
```

Replace defaults entirely:

```bash
xyte-cli flow edit flow.local-watch-triage \
  --replace-defaults \
  --var region=us \
  --var window_hours=6
```

<details>
<summary>Toggle: edit behavior</summary>

- default `flow edit` merges new `--var` keys into existing defaults.
- `--replace-defaults` replaces the stored defaults map entirely.
- changing `--based-on` swaps the built-in recipe the alias points to.

</details>

## Share And Import

Export:

```bash
xyte-cli flow share flow.local-watch-triage --out ./tmp/flow.local-watch-triage.json
```

Import:

```bash
xyte-cli flow import --file ./tmp/flow.local-watch-triage.json
```

Overwrite existing on import:

```bash
xyte-cli flow import --file ./tmp/flow.local-watch-triage.json --force
```

<details>
<summary>Toggle: what is shareable</summary>

Shared flow JSON includes:
- custom flow id
- base built-in flow id
- title/description
- stored default context values

</details>

## Context Inputs

Runtime context comes from:

1. Custom flow defaults
2. `--context-json` values
3. `--var key=value` values

`--var` wins over `--context-json`, and runtime inputs win over stored defaults.

```bash
xyte-cli flow run flow.local-guided-remediation \
  --tenant <tenant-id> \
  --plan \
  --context-json ./flow.context.json \
  --var device_id=<device-id>
```

## Apply And Resume

`--plan` stops at the first human gate.

```bash
xyte-cli flow run flow.local-guided-remediation --tenant <tenant-id> --plan
```

`--apply --resume` advances one gate per invocation.

```bash
xyte-cli flow run flow.local-guided-remediation \
  --tenant <tenant-id> \
  --apply \
  --resume <run-id-or-run-dir>
```

If required context or upstream data is missing, runs stop with `outcome=needs_input` and classification `needs_data`.

## Artifacts

By default each run writes to:

`./tmp/flow-runs/<flow-id>/<timestamp>-<run-id>/`

Key files:
- `manifest.json`
- `inputs.json`
- `decisions.ndjson`
- `errors.ndjson`
- `watch-frames.ndjson`
- `steps/*`
- `outputs/*`

## Local Tenant Example

Create a local custom remediation alias with pinned IDs:

```bash
xyte-cli flow create flow.local3000-guided-remediation \
  --based-on flow.guided-remediation \
  --title "Local 3000 Guided Remediation" \
  --var device_id=<device-id> \
  --var incident_id=<incident-id> \
  --var ticket_id=<ticket-id>
```

Then validate in `--plan` before any apply:

```bash
xyte-cli flow run flow.local3000-guided-remediation --tenant local3000 --plan
```

## References

- Built-in flow recipes: [`agent-ops.md`](./agent-ops.md)
- Command reference: [`../commands.md`](../commands.md)
