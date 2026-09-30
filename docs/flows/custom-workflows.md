# Custom Workflow Authoring

Use custom flows when you want a stable alias with prefilled defaults for your tenant/team.

Custom flows do not define new step graphs. They alias one built-in flow and pin default context values.

## Quick Start

List built-in flow IDs:

```bash
xyte-cli flow list --format text
```

Common write-capable built-ins include `flow.device-command`, `flow.guided-remediation`, and `flow.device-migration`. Edge-specific built-ins include `flow.edge-model-discovery`, `flow.edge-claim`, `flow.edge-claim-batch`, `flow.edge-params-update`, `flow.edge-params-update-batch`, and `flow.edge-ping`.

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

```bash
xyte-cli flow create flow.ops-device-command \
  --based-on flow.device-command \
  --title "Ops Device Command" \
  --var device_id=<device-id>
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
xyte-cli flow share flow.local-watch-triage --out ./artifacts/flow.local-watch-triage.json
```

Import:

```bash
xyte-cli flow import --file ./artifacts/flow.local-watch-triage.json
```

Overwrite existing on import:

```bash
xyte-cli flow import --file ./artifacts/flow.local-watch-triage.json --force
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

## Edge-Claim Aliases

Pin poll timeouts and the already-discovered model id for your team's edge-claim rollouts. `flow.edge-claim` and `flow.edge-claim-batch` fetch Edge model data before their claim gates, so keep `device_model_id` current when a customer adds new models.

```bash
xyte-cli flow create flow.noc-edge-claim-batch \
  --based-on flow.edge-claim-batch \
  --title "NOC Edge Claim Batch" \
  --var device_model_id=<model-id> \
  --var edge_poll_interval_ms=5000 \
  --var edge_poll_timeout_ms=900000
```

Full native-vs-edge disambiguation and C2C-unsupported guidance: [`../claim-devices.md`](../claim-devices.md).

## Edge Params Aliases

Pin a recurring already-claimed Edge parameter update for one device:

```bash
xyte-cli flow create flow.noc-edge-params-room101 \
  --based-on flow.edge-params-update \
  --title "NOC Room 101 Edge Params" \
  --var device_id=<device-id> \
  --var set_json='{"Port":"161"}'
```

For a spreadsheet-driven rollout, alias `flow.edge-params-update-batch` and pin `edge_params_input_path=<file>`.

## References

- Built-in flow recipes: [`agent-ops.md`](./agent-ops.md)
- Command reference: [`../commands.md`](../commands.md)
