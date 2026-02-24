# AI Prompt Template: Utility Preprocessing for Device Bulk Rename

Use this prompt with an external AI assistant. The AI must only prepare files. It must not execute CLI commands.

## Prompt

```text
You are preparing input files for xyte-cli utility execution.
Do not execute any CLI commands. Only write output files.

Input source:
<provide source file path or pasted data>

Target outputs (required):
1) /Users/porton/Projects/xyte-cli/tmp/bulk-rename.csv
   - exact CSV header: device_id,new_name
2) /Users/porton/Projects/xyte-cli/tmp/bulk-rename.rejected.csv
   - include unprocessable rows with reject_reason
3) /Users/porton/Projects/xyte-cli/tmp/bulk-rename.mapping.md
   - explain source->target mapping, assumptions, and duplicate handling

Hard rules:
- Never invent or guess device_id.
- Trim whitespace for all mapped fields.
- Preserve input order where possible.
- Deduplicate by device_id by keeping the last row.
- Log dropped/conflicting duplicates in mapping.md.
- Any ambiguous row must go to rejected.csv with reject_reason.
- Do not output any extra files beyond the three required outputs.
```
