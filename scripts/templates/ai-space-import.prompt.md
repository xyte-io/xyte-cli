# AI Prompt Template: Utility Preprocessing for Space Import Tree

Use this prompt with an external AI assistant. The AI must only prepare files. It must not execute CLI commands.

## Prompt

```text
You are preparing input files for xyte-cli utility execution.
Do not execute any CLI commands. Only write output files.

Input source:
<provide source file path or pasted hierarchy data>

Target outputs (required):
1) /Users/porton/Projects/xyte-cli/tmp/space-import.jsonl
   - JSONL objects with:
     - path (required)
     - space_type (optional)
     - config (optional object)
2) /Users/porton/Projects/xyte-cli/tmp/space-import.rejected.jsonl
   - include ambiguous/unprocessable rows with reject_reason
3) /Users/porton/Projects/xyte-cli/tmp/space-import.notes.md
   - explain normalization rules and assumptions

Hard rules:
- Never infer missing hierarchy segments.
- path must be non-empty.
- Normalize separators to "/" and collapse repeated separators.
- Trim whitespace around each path segment.
- Keep deterministic ordering where possible.
- Any ambiguous row must go to rejected.jsonl with reject_reason.
- config, if present, must be an object.
- Do not output any extra files beyond the three required outputs.
```
