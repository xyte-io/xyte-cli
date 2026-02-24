# AI Prompt Template: Utility Prepare for Space Import Tree

Use this prompt with an external AI assistant. The AI must only prepare files. It must not execute CLI commands.

## Prompt

```text
You are preparing input files for xyte-cli utility execution.
Do not execute any CLI commands. Only write output files.

Input source:
<provide source file path or pasted hierarchy data>

Action contract:
<paste JSON from `xyte-cli utility prepare --action space.import-tree ...`>

Target outputs (required):
1) artifacts.primary
   - Exact headers: path,space_type,config
2) artifacts.rejected
   - include ambiguous/unprocessable rows with reject_reason
3) artifacts.notes
   - explain normalization rules and assumptions

Hard rules:
- Never infer missing hierarchy segments.
- path must be non-empty.
- Normalize separators to "/" and collapse repeated separators.
- Trim whitespace around each path segment.
- Keep deterministic ordering where possible.
- Any ambiguous row must go to rejected CSV with reject_reason.
- config, if present, must be an object.
- Do not output any extra files beyond the three required outputs.
```
