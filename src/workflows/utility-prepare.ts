import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { CliUserError } from '../contracts/user-error';
import { UTILITY_PREPARE_SCHEMA_VERSION } from '../contracts/versions';
import { getUtilityActionProfile, listUtilityActionProfiles } from './utility-action-catalog';
import type {
  UtilityActionProfile,
  UtilityExecutionSupport,
  UtilityPreparePrimaryFormat,
  UtilityPrepareMode
} from './utility-action-profiles';

type UtilityPrepareInputKind = UtilityPrepareResult['input']['kind'];

const UtilityPrepareResultSchema = z.object({
  schemaVersion: z.literal(UTILITY_PREPARE_SCHEMA_VERSION),
  generatedAtUtc: z.string(),
  actionKey: z.string(),
  entity: z.string(),
  mode: z.enum(['friendly', 'generic']),
  input: z.object({
    path: z.string(),
    kind: z.enum(['tabular', 'document', 'image', 'unknown']),
    extension: z.string(),
    sizeBytes: z.number()
  }),
  canonical: z.object({
    primaryFormat: z.enum(['csv', 'jsonl']),
    headers: z.array(z.string()),
    jsonShape: z.record(z.string(), z.unknown())
  }),
  decodeRules: z.array(z.string()),
  artifacts: z.object({
    primary: z.string(),
    rejected: z.string(),
    notes: z.string()
  }),
  promptTemplatePath: z.string(),
  skillNodePath: z.string(),
  suggestedCommands: z.object({
    next: z.string(),
    apply: z.string(),
    verify: z.string()
  }),
  executionSupport: z.enum(['space.import-tree', 'device.move', 'edge.claim-batch', 'call-loop-only'])
});

type UtilityPrepareResult = z.infer<typeof UtilityPrepareResultSchema>;

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
    throw new CliUserError({ summary: `Scaffold file already exists: ${filePath}. Re-run with --force to overwrite.` });
  }
  writeFileSync(filePath, content, 'utf8');
}

function toActionSlug(actionKey: string): string {
  return actionKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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
  if (profile.actionKey === 'organization.commands.sendCommand') {
    return {
      next: [
        `Review ${primaryPath}.`,
        'Preflight gate: for each device_id, run organization.commands.getCommands first and pick only valid command/friendly_name values.',
        'If no valid command/friendly_name is known for a device, skip writes for that row.'
      ].join(' '),
      apply: `xyte-cli api call organization.commands.sendCommand --tenant ${tenant} --path-json '{"device_id":"<device_id>"}' --body-json '{"command":"<valid-command>"}'`,
      verify: `xyte-cli api call organization.commands.getCommands --tenant ${tenant} --path-json '{"device_id":"<device_id>"}' --query-json '{"page":1,"per_page":20}'`
    };
  }

  if (profile.actionKey === 'organization.devices.claimDevice') {
    return {
      next: [
        `Review ${primaryPath}.`,
        'Preflight gate: validate target space_id rows with organization.spaces.getSpace before write loops.',
        'Run one envelope probe row first; if upstream returns "No device found", skip bulk claim writes and collect claimable identifiers.'
      ].join(' '),
      apply: `xyte-cli api call organization.devices.claimDevice --tenant ${tenant} --output-mode envelope --body-json '{"name":"<name>","space_id":<space_id>,"sn":"<sn>","mac":"<mac>","cloud_id":"<cloud_id>"}'`,
      verify: `xyte-cli api call organization.devices.getDevices --tenant ${tenant} --query-json '{"space_id":"<space_id>"}'`
    };
  }

  if (profile.actionKey === 'organization.devices.updateDevice') {
    return {
      next: [
        `Review ${primaryPath}.`,
        'Preflight gate: capture baseline values with organization.devices.getDevice before write loops.',
        'After each update, read back the device and verify the targeted fields changed as expected.'
      ].join(' '),
      apply: `xyte-cli api call organization.devices.updateDevice --tenant ${tenant} --path-json '{"device_id":"<device_id>"}' --body-json '{"name":"<updated-name>"}'`,
      verify: `xyte-cli api call organization.devices.getDevice --tenant ${tenant} --path-json '{"device_id":"<device_id>"}'`
    };
  }

  if (profile.actionKey === 'device.move') {
    return {
      next: [
        `Review ${primaryPath}.`,
        'Validate the target_space_id column before any writes.',
        'Run util move-devices without --apply first and only execute after the dry-run report looks correct.'
      ].join(' '),
      apply: `xyte-cli util move-devices --tenant ${tenant} --input ${primaryPath} --apply --report ${path.join(outputDir, 'device-move.apply.ndjson')}`,
      verify: `xyte-cli api call organization.devices.getDevice --tenant ${tenant} --path-json '{"device_id":"<device_id>"}'`
    };
  }

  if (profile.actionKey === 'organization.edge.startClaim') {
    const reportPath = path.join(outputDir, 'edge-claim.apply.ndjson');
    const resumePath = path.join(outputDir, 'edge-claim.resume.ndjson');
    return {
      next: [
        `Review ${primaryPath}.`,
        'Run xyte-cli edge claim-batch with --plan first; apply only after the dry-run plan looks correct.',
        'Resume interrupted runs by re-running --apply with the same --resume-artifact <path>.'
      ].join(' '),
      apply:
        `xyte-cli edge claim-batch --tenant ${tenant} --input ${primaryPath} --apply ` +
        `--report ${reportPath} --resume-artifact ${resumePath}`,
      verify: `xyte-cli edge claim-status --tenant ${tenant} --proxy-id <proxy-id> --device-ip <device-ip>`
    };
  }

  if (profile.executionSupport === 'space.import-tree') {
    return {
      next: `xyte-cli util import-tree --tenant ${tenant} --input ${primaryPath}`,
      apply: `xyte-cli util import-tree --tenant ${tenant} --input ${primaryPath} --apply --report ${path.join(outputDir, 'space-import.apply.ndjson')}`,
      verify: `xyte-cli api call organization.spaces.getSpaces --tenant ${tenant} --query-json '{"path_includes":"<sample-path>"}'`
    };
  }

  const samplePathObject = profile.headers
    .filter((header) => header !== 'query_json' && header !== 'body_json')
    .reduce<Record<string, string>>((accumulator, header) => {
      accumulator[header] = `<${header}>`;
      return accumulator;
    }, {});

  return {
    next: `Review ${primaryPath}, then decide whether to execute ${profile.actionKey} via xyte-cli api call loop.`,
    apply: `xyte-cli api call ${profile.actionKey} --tenant ${tenant} --path-json '${JSON.stringify(samplePathObject)}' --query-json '{"...":"..."}' --body-json '{"...":"..."}'`,
    verify: `xyte-cli api endpoints describe ${profile.actionKey}`
  };
}

function requiredHeadersForProfile(profile: UtilityActionProfile): string[] {
  if (profile.actionKey === 'space.import-tree') {
    return ['path'];
  }
  if (profile.actionKey === 'organization.edge.startClaim') {
    return ['proxy_id', 'device_ip', 'device_model_id', 'space_id'];
  }
  if (profile.actionKey === 'device.move') {
    return ['device_id', 'target_space_id'];
  }
  if (profile.mode === 'generic') {
    return profile.headers.filter((header) => header !== 'query_json' && header !== 'body_json');
  }
  return profile.headers.filter((header) => !['cloud_id', 'mac', 'sn', 'custom_parameters'].includes(header));
}

function exampleForHeader(profile: UtilityActionProfile, header: string): string {
  const value = profile.jsonShape[header];
  if (value !== undefined) {
    return JSON.stringify(value);
  }
  if (header === 'query_json' || header === 'body_json') {
    return '{}';
  }
  const nestedPath = profile.jsonShape.path;
  if (nestedPath && typeof nestedPath === 'object' && !Array.isArray(nestedPath) && header in nestedPath) {
    return JSON.stringify((nestedPath as Record<string, unknown>)[header]);
  }
  return JSON.stringify(`<${header}>`);
}

function rejectTaxonomy(profile: UtilityActionProfile, requiredHeaders: string[]): string[] {
  const reasons = requiredHeaders.map((header) => `missing_${header}`);
  const jsonHeaders = profile.headers.filter((header) => header.endsWith('_json') || header === 'config' || header === 'custom_parameters');
  reasons.push(...jsonHeaders.map((header) => `invalid_${header}`));
  reasons.push('ambiguous_row');
  return [...new Set(reasons)];
}

function buildNotes(
  profile: UtilityActionProfile,
  inputPath: string,
  suggestedCommands: UtilityPrepareResult['suggestedCommands']
): string {
  const requiredHeaders = requiredHeadersForProfile(profile);
  const requiredSet = new Set(requiredHeaders);
  const rejectReasons = rejectTaxonomy(profile, requiredHeaders);
  return [
    '# Utility Prepare Notes',
    '',
    `Action: ${profile.actionKey}`,
    `Mode: ${profile.mode}`,
    `Execution support: ${profile.executionSupport}`,
    `Source input: ${inputPath}`,
    '',
    '## Canonical Fields',
    ...profile.headers.map((header) => `- ${header}: ${requiredSet.has(header) ? 'required' : 'optional'}; example ${exampleForHeader(profile, header)}`),
    '',
    '## JSONL Example',
    '```json',
    JSON.stringify(profile.jsonShape, null, 2),
    '```',
    '',
    '## Decode Rules',
    ...profile.decodeRules.map((rule) => `- ${rule}`),
    '',
    '## Reject Taxonomy',
    ...rejectReasons.map((reason) => `- ${reason}`),
    '',
    '## Ambiguities',
    '- Place unresolved rows into the rejected file with reject_reason.',
    '',
    '## Safe Next Commands',
    `- Next: ${suggestedCommands.next}`,
    `- Apply: ${suggestedCommands.apply}`,
    `- Verify: ${suggestedCommands.verify}`,
    '',
    '## Operator Decision Gate',
    '- After preprocessing is complete, ask what to do next (execute or stop).'
  ].join('\n');
}

function buildCsvHeader(headers: string[]): string {
  return `${headers.join(',')}\n`;
}

/** Intentionally synchronous: all I/O uses synchronous Node.js APIs (existsSync, statSync, mkdirSync, writeFileSync). */
export function runUtilityPrepare(args: {
  inputPath: string;
  actionKey: string;
  outputDir?: string;
  tenantId?: string;
  primaryFormat?: UtilityPreparePrimaryFormat;
  force?: boolean;
}): UtilityPrepareResult {
  const inputPath = path.resolve(args.inputPath);
  if (!existsSync(inputPath)) {
    throw new CliUserError({ summary: `Input file does not exist: ${inputPath}` });
  }
  const inputStats = statSync(inputPath);
  if (!inputStats.isFile()) {
    throw new CliUserError({ summary: `Input path must be a file: ${inputPath}` });
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
  const suggestedCommands = buildSuggestedCommands(profile, tenant, primary, outputDir);
  writeScaffoldFile(notes, `${buildNotes(profile, inputPath, suggestedCommands)}\n`, force);

  return UtilityPrepareResultSchema.parse({
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
    suggestedCommands,
    executionSupport: profile.executionSupport
  });
}

interface UtilityActionSummary {
  actionKey: string;
  entity: string;
  title: string;
  mode: UtilityPrepareMode;
  method: string | null;
  pathTemplate: string | null;
  executionSupport: UtilityExecutionSupport;
}

export function listUtilityPrepareActions(
  args: {
    entity?: string;
    includeGeneric?: boolean;
    mode?: UtilityPrepareMode;
    executionSupport?: UtilityExecutionSupport;
  } = {}
): UtilityActionSummary[] {
  return listUtilityActionProfiles({
    entity: args.entity,
    includeGeneric: args.includeGeneric
  })
    .filter((profile) => !args.mode || profile.mode === args.mode)
    .filter((profile) => !args.executionSupport || profile.executionSupport === args.executionSupport)
    .sort((left, right) => {
      if (left.mode !== right.mode) {
        return left.mode === 'friendly' ? -1 : 1;
      }
      if (left.executionSupport !== right.executionSupport) {
        return left.executionSupport.localeCompare(right.executionSupport);
      }
      return left.actionKey.localeCompare(right.actionKey);
    })
    .map((profile) => ({
      actionKey: profile.actionKey,
      entity: profile.entity,
      title: profile.title,
      mode: profile.mode,
      method: profile.method ?? null,
      pathTemplate: profile.pathTemplate ?? null,
      executionSupport: profile.executionSupport
    }));
}
