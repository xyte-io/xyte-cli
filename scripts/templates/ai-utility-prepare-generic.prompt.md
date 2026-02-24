# AI Prompt Template: Utility Prepare (Generic Action)

Use this prompt with an external AI assistant. The AI must only prepare files. It must not execute CLI commands.

## Prompt

```text
You are preparing input files for xyte-cli utility preprocessing.
Do not execute any CLI commands. Only write output files.

Input source:
<provide source file path or pasted data>

Action contract:
<paste JSON from `xyte-cli utility prepare --action <action-key> ...`>

Write exactly these files from the contract:
1) artifacts.primary
2) artifacts.rejected
3) artifacts.notes

Hard rules:
- Never guess identifiers that are not present in source input.
- Trim leading/trailing whitespace.
- Preserve deterministic row ordering where possible.
- If a row is ambiguous, put it in rejected output with reject_reason.
- For generic CSV mode:
  - path parameter columns must stay scalar.
  - query_json must be valid JSON object string or empty.
  - body_json must be valid JSON object string or empty.
- Do not output any files beyond artifacts.primary/rejected/notes.
```
