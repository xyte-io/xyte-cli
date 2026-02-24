import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { UTILITY_PREPARE_SCHEMA_VERSION } from '../contracts/versions';
import { getUtilityActionProfile, listUtilityActionProfiles } from './utility-action-catalog';
import type { UtilityActionProfile, UtilityPreparePrimaryFormat } from './utility-action-profiles';

export type UtilityPrepareInputKind = 'tabular' | 'document' | 'image' | 'unknown';

export interface UtilityPrepareResult {
  schemaVersion: typeof UTILITY_PREPARE_SCHEMA_VERSION;
  generatedAtUtc: string;
  actionKey: string;
  entity: string;
  mode: 'friendly' | 'generic';
  input: {
    path: string;
    kind: UtilityPrepareInputKind;
    extension: string;
    sizeBytes: number;
  };
  canonical: {
    primaryFormat: UtilityPreparePrimaryFormat;
    headers: string[];
    jsonShape: Record<string, unknown>;
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
    next: string;
    apply: string;
    verify: string;
  };
  executionSupport: 'space.import-tree' | 'call-loop-only';
}

const TABULAR_EXTENSIONS = new Set(['.csv', '.tsv', '.xlsx', '.xls', '.json', '.jsonl', '.ndjson']);
const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.md', '.txt', '.doc', '.docx', '.rtf']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff']);

function detectInputKind(extension: string): UtilityPrepareInputKind {
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

function toActionSlug(actionKey: string): string {
  return actionKey.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function buildSuggestedTenant(tenantId?: string): string {
  return tenantId && tenantId.trim() ? tenantId.trim() : '<tenant-id>';
}

function buildSuggestedCommands(
  profile: UtilityActionProfile,
  tenant: string,
  primaryPath: string,
  outputDir: string
): UtilityPrepareResult['suggestedCommands'] {
  if (profile.executionSupport === 'space.import-tree') {
    return {
      next: `xyte-cli space import-tree --tenant ${tenant} --input ${primaryPath}`,
      apply: `xyte-cli space import-tree --tenant ${tenant} --input ${primaryPath} --apply --report ${path.join(outputDir, 'space-import.apply.ndjson')}`,
      verify: `xyte-cli call organization.spaces.getSpaces --tenant ${tenant} --query-json '{"path_includes":"<sample-path>"}'`
    };
  }

  const samplePathObject = profile.headers
    .filter((header) => header !== 'query_json' && header !== 'body_json')
    .reduce<Record<string, string>>((accumulator, header) => {
      accumulator[header] = `<${header}>`;
      return accumulator;
    }, {});

  return {
    next: `Review ${primaryPath}, then decide whether to execute ${profile.actionKey} via xyte-cli call loop.`,
    apply: `xyte-cli call ${profile.actionKey} --tenant ${tenant} --allow-write --path-json '${JSON.stringify(samplePathObject)}' --query-json '{"...":"..."}' --body-json '{"...":"..."}'`,
    verify: `xyte-cli describe-endpoint ${profile.actionKey}`
  };
}

function buildNotes(profile: UtilityActionProfile, inputPath: string): string {
  return [
    '# Utility Prepare Notes',
    '',
    `Action: ${profile.actionKey}`,
    `Mode: ${profile.mode}`,
    `Source input: ${inputPath}`,
    '',
    '## Canonical Fields',
    `- ${profile.headers.join(', ')}`,
    '',
    '## Decode Rules',
    ...profile.decodeRules.map((rule) => `- ${rule}`),
    '',
    '## Ambiguities',
    '- Place unresolved rows into the rejected file with reject_reason.',
    '',
    '## Operator Decision Gate',
    '- After preprocessing is complete, ask what to do next (execute or stop).'
  ].join('\n');
}

function buildCsvHeader(headers: string[]): string {
  return `${headers.join(',')}\n`;
}

export function buildUtilityPrepare(args: {
  inputPath: string;
  actionKey: string;
  outputDir?: string;
  tenantId?: string;
  primaryFormat?: UtilityPreparePrimaryFormat;
  force?: boolean;
}): UtilityPrepareResult {
  const inputPath = path.resolve(args.inputPath);
  if (!existsSync(inputPath)) {
    throw new Error(`Input file does not exist: ${inputPath}`);
  }
  const inputStats = statSync(inputPath);
  if (!inputStats.isFile()) {
    throw new Error(`Input path must be a file: ${inputPath}`);
  }

  const profile = getUtilityActionProfile(args.actionKey);
  const outputDir = path.resolve(args.outputDir ?? './tmp');
  mkdirSync(outputDir, { recursive: true });
  const force = args.force === true;
  const tenant = buildSuggestedTenant(args.tenantId);
  const extension = path.extname(inputPath).toLowerCase();
  const kind = detectInputKind(extension);
  const primaryFormat = args.primaryFormat ?? profile.primaryFormat;
  const actionSlug = toActionSlug(profile.actionKey);
  const primary = path.join(outputDir, `${actionSlug}.${primaryFormat}`);
  const rejected = path.join(outputDir, `${actionSlug}.rejected.${primaryFormat}`);
  const notes = path.join(outputDir, `${actionSlug}.notes.md`);

  if (primaryFormat === 'csv') {
    writeScaffoldFile(primary, buildCsvHeader(profile.headers), force);
    writeScaffoldFile(rejected, buildCsvHeader([...profile.headers, 'reject_reason']), force);
  } else {
    writeScaffoldFile(primary, '', force);
    writeScaffoldFile(rejected, '', force);
  }
  writeScaffoldFile(notes, `${buildNotes(profile, inputPath)}\n`, force);

  return {
    schemaVersion: UTILITY_PREPARE_SCHEMA_VERSION,
    generatedAtUtc: new Date().toISOString(),
    actionKey: profile.actionKey,
    entity: profile.entity,
    mode: profile.mode,
    input: {
      path: inputPath,
      kind,
      extension,
      sizeBytes: inputStats.size
    },
    canonical: {
      primaryFormat,
      headers: profile.headers,
      jsonShape: profile.jsonShape
    },
    decodeRules: profile.decodeRules,
    artifacts: {
      primary,
      rejected,
      notes
    },
    promptTemplatePath: profile.promptTemplatePath,
    skillNodePath: profile.skillNodePath,
    suggestedCommands: buildSuggestedCommands(profile, tenant, primary, outputDir),
    executionSupport: profile.executionSupport
  };
}

export function listUtilityPrepareActions(args: { entity?: string; includeGeneric?: boolean } = {}) {
  return listUtilityActionProfiles({
    entity: args.entity,
    includeGeneric: args.includeGeneric
  }).map((profile) => ({
    actionKey: profile.actionKey,
    entity: profile.entity,
    title: profile.title,
    mode: profile.mode,
    method: profile.method ?? null,
    pathTemplate: profile.pathTemplate ?? null,
    executionSupport: profile.executionSupport
  }));
}
