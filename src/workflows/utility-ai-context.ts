import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { UTILITY_AI_CONTEXT_SCHEMA_VERSION } from '../contracts/versions';

export type UtilityAiContextEntity = 'devices' | 'spaces';
export type UtilityAiContextInputKind = 'tabular' | 'document' | 'image' | 'unknown';

export interface UtilityAiContextResult {
  schemaVersion: typeof UTILITY_AI_CONTEXT_SCHEMA_VERSION;
  generatedAtUtc: string;
  entity: UtilityAiContextEntity;
  mappedAction: 'device.bulk-rename' | 'space.import-tree';
  input: {
    path: string;
    kind: UtilityAiContextInputKind;
    extension: string;
    sizeBytes: number;
  };
  decodeRules: string[];
  artifacts: {
    primary: string;
    rejected: string;
    notes: string;
  };
  promptTemplatePath: string;
  skillNodePath: string;
  suggestedCommands: {
    dryRun: string;
    apply: string;
    verify: string;
  };
}

const TABULAR_EXTENSIONS = new Set(['.csv', '.tsv', '.xlsx', '.xls', '.json', '.jsonl', '.ndjson']);
const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.md', '.txt', '.doc', '.docx', '.rtf']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff']);

function detectInputKind(extension: string): UtilityAiContextInputKind {
  const normalized = extension.toLowerCase();
  if (TABULAR_EXTENSIONS.has(normalized)) {
    return 'tabular';
  }
  if (DOCUMENT_EXTENSIONS.has(normalized)) {
    return 'document';
  }
  if (IMAGE_EXTENSIONS.has(normalized)) {
    return 'image';
  }
  return 'unknown';
}

function writeScaffoldFile(filePath: string, content: string, force: boolean): void {
  if (existsSync(filePath) && !force) {
    throw new Error(`Scaffold file already exists: ${filePath}. Re-run with --force to overwrite.`);
  }
  writeFileSync(filePath, content, 'utf8');
}

function buildDevicesNotesSkeleton(inputPath: string): string {
  return [
    '# Bulk Rename Mapping Notes',
    '',
    `Source input: ${inputPath}`,
    '',
    '## Field Mapping',
    '- source columns -> `device_id,new_name`',
    '',
    '## Rules',
    '- Never invent `device_id`.',
    '- Trim whitespace.',
    '- Deduplicate by `device_id` (keep last).',
    '- Put ambiguous rows in rejected output with `reject_reason`.',
    '',
    '## Conflicts / Assumptions',
    '- Fill in duplicate/conflict handling notes here.'
  ].join('\n');
}

function buildSpacesNotesSkeleton(inputPath: string): string {
  return [
    '# Space Import Notes',
    '',
    `Source input: ${inputPath}`,
    '',
    '## Normalization Rules',
    '- `path` required and non-empty.',
    '- Normalize separators to `/`.',
    '- Trim whitespace around path segments.',
    '- Do not infer missing hierarchy segments.',
    '- `config` must be an object (or valid JSON string that parses to an object).',
    '',
    '## Ambiguities',
    '- Put ambiguous rows in rejected output with `reject_reason`.',
    '',
    '## Assumptions',
    '- Fill in hierarchy assumptions here.'
  ].join('\n');
}

function buildSuggestedTenant(tenantId?: string): string {
  return tenantId && tenantId.trim() ? tenantId.trim() : '<tenant-id>';
}

export function buildUtilityAiContext(args: {
  inputPath: string;
  entity: UtilityAiContextEntity;
  outputDir?: string;
  tenantId?: string;
  force?: boolean;
}): UtilityAiContextResult {
  const inputPath = path.resolve(args.inputPath);
  if (!existsSync(inputPath)) {
    throw new Error(`Input file does not exist: ${inputPath}`);
  }
  const inputStats = statSync(inputPath);
  if (!inputStats.isFile()) {
    throw new Error(`Input path must be a file: ${inputPath}`);
  }

  const outputDir = path.resolve(args.outputDir ?? './tmp');
  mkdirSync(outputDir, { recursive: true });
  const force = args.force === true;
  const tenant = buildSuggestedTenant(args.tenantId);
  const extension = path.extname(inputPath).toLowerCase();
  const kind = detectInputKind(extension);

  if (args.entity === 'devices') {
    const primary = path.join(outputDir, 'bulk-rename.csv');
    const rejected = path.join(outputDir, 'bulk-rename.rejected.csv');
    const notes = path.join(outputDir, 'bulk-rename.mapping.md');

    writeScaffoldFile(primary, 'device_id,new_name\n', force);
    writeScaffoldFile(rejected, 'device_id,new_name,reject_reason\n', force);
    writeScaffoldFile(notes, `${buildDevicesNotesSkeleton(inputPath)}\n`, force);

    return {
      schemaVersion: UTILITY_AI_CONTEXT_SCHEMA_VERSION,
      generatedAtUtc: new Date().toISOString(),
      entity: 'devices',
      mappedAction: 'device.bulk-rename',
      input: {
        path: inputPath,
        kind,
        extension,
        sizeBytes: inputStats.size
      },
      decodeRules: [
        'Map source rows to exact columns: device_id,new_name.',
        'Never guess device_id values.',
        'Trim leading/trailing whitespace.',
        'Deduplicate by device_id with keep-last policy.',
        'Write ambiguous rows into rejected file with reject_reason.'
      ],
      artifacts: {
        primary,
        rejected,
        notes
      },
      promptTemplatePath: '/Users/porton/Projects/xyte-cli/scripts/templates/ai-bulk-rename.prompt.md',
      skillNodePath: '/Users/porton/Projects/xyte-cli/skills/xyte-cli/references/utility-ai-device-bulk-rename.md',
      suggestedCommands: {
        dryRun: `xyte-cli device bulk-rename --tenant ${tenant} --input ${primary} --report ${path.join(outputDir, 'bulk-rename.dryrun.ndjson')}`,
        apply: `xyte-cli device bulk-rename --tenant ${tenant} --input ${primary} --apply --report ${path.join(outputDir, 'bulk-rename.apply.ndjson')}`,
        verify: `xyte-cli call organization.devices.getDevice --tenant ${tenant} --path-json '{"device_id":"<sample-device-id>"}'`
      }
    };
  }

  const primary = path.join(outputDir, 'space-import.jsonl');
  const rejected = path.join(outputDir, 'space-import.rejected.jsonl');
  const notes = path.join(outputDir, 'space-import.notes.md');

  writeScaffoldFile(primary, '', force);
  writeScaffoldFile(rejected, '', force);
  writeScaffoldFile(notes, `${buildSpacesNotesSkeleton(inputPath)}\n`, force);

  return {
    schemaVersion: UTILITY_AI_CONTEXT_SCHEMA_VERSION,
    generatedAtUtc: new Date().toISOString(),
    entity: 'spaces',
    mappedAction: 'space.import-tree',
    input: {
      path: inputPath,
      kind,
      extension,
      sizeBytes: inputStats.size
    },
    decodeRules: [
      'Map source rows/entries into JSONL objects with path required.',
      'Normalize path separators to "/".',
      'Do not infer missing hierarchy segments.',
      'space_type is optional.',
      'config must be an object (or JSON string that parses to an object).',
      'Write ambiguous rows into rejected output with reject_reason.'
    ],
    artifacts: {
      primary,
      rejected,
      notes
    },
    promptTemplatePath: '/Users/porton/Projects/xyte-cli/scripts/templates/ai-space-import.prompt.md',
    skillNodePath: '/Users/porton/Projects/xyte-cli/skills/xyte-cli/references/utility-ai-space-import-tree.md',
    suggestedCommands: {
      dryRun: `xyte-cli space import-tree --tenant ${tenant} --input ${primary} --report ${path.join(outputDir, 'space-import.dryrun.ndjson')}`,
      apply: `xyte-cli space import-tree --tenant ${tenant} --input ${primary} --apply --report ${path.join(outputDir, 'space-import.apply.ndjson')}`,
      verify: `xyte-cli call organization.spaces.getSpaces --tenant ${tenant} --query-json '{"path_includes":"<sample-path>"}'`
    }
  };
}
