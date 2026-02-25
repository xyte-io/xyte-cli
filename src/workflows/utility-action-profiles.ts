import type { PublicEndpointSpec } from '../types/endpoints';

export type UtilityPreparePrimaryFormat = 'csv' | 'jsonl';
export type UtilityPrepareMode = 'friendly' | 'generic';
export type UtilityExecutionSupport = 'space.import-tree' | 'call-loop-only';

export interface UtilityActionProfile {
  actionKey: string;
  title: string;
  entity: string;
  mode: UtilityPrepareMode;
  endpointKey?: string;
  method?: PublicEndpointSpec['method'];
  pathTemplate?: string;
  primaryFormat: UtilityPreparePrimaryFormat;
  headers: string[];
  jsonShape: Record<string, unknown>;
  decodeRules: string[];
  promptTemplatePath: string;
  skillNodePath: string;
  executionSupport: UtilityExecutionSupport;
}

const GENERIC_PROMPT_TEMPLATE_PATH = 'scripts/templates/ai-utility-prepare-generic.prompt.md';
const SPACE_IMPORT_PROMPT_TEMPLATE_PATH = 'scripts/templates/ai-space-import.prompt.md';
const UTILITIES_SKILL_NODE_PATH = 'skills/xyte-cli/references/utilities.md';
const SPACE_IMPORT_SKILL_NODE_PATH = 'skills/xyte-cli/references/utility-ai-space-import-tree.md';

export function buildFriendlySpaceImportProfile(): UtilityActionProfile {
  return {
    actionKey: 'space.import-tree',
    title: 'Space Import Tree',
    entity: 'spaces',
    mode: 'friendly',
    endpointKey: 'organization.spaces.findOrCreateSpace',
    method: 'POST',
    pathTemplate: '/core/v1/organization/spaces/find_or_create',
    primaryFormat: 'csv',
    headers: ['path', 'space_type', 'config'],
    jsonShape: {
      path: 'HQ/Floor 1/Room A',
      space_type: 'office',
      config: {
        zone: 'north'
      }
    },
    decodeRules: [
      'Map source rows into path,space_type,config columns.',
      'path is required and must be non-empty.',
      'Normalize path separators to "/".',
      'Do not infer missing hierarchy segments.',
      'config must be an object (or JSON string that parses to object).',
      'Write ambiguous rows to rejected output with reject_reason.'
    ],
    promptTemplatePath: SPACE_IMPORT_PROMPT_TEMPLATE_PATH,
    skillNodePath: SPACE_IMPORT_SKILL_NODE_PATH,
    executionSupport: 'space.import-tree'
  };
}

export function buildFriendlyClaimDeviceProfile(endpoint: PublicEndpointSpec): UtilityActionProfile {
  return {
    actionKey: endpoint.key,
    title: endpoint.title,
    entity: endpoint.group,
    mode: 'friendly',
    endpointKey: endpoint.key,
    method: endpoint.method,
    pathTemplate: endpoint.pathTemplate,
    primaryFormat: 'csv',
    headers: ['name', 'space_id', 'sn', 'mac', 'cloud_id'],
    jsonShape: {
      name: 'Friendly device name',
      space_id: 123,
      sn: 'SERIAL-001',
      mac: 'aa:bb:cc:dd:ee:ff',
      cloud_id: ''
    },
    decodeRules: [
      'Map source rows into name,space_id,sn,mac,cloud_id columns.',
      'Keep rows deterministic and trim surrounding whitespace.',
      'Do not guess missing identifiers; reject ambiguous rows.',
      'Write unresolved rows to rejected output with reject_reason.'
    ],
    promptTemplatePath: GENERIC_PROMPT_TEMPLATE_PATH,
    skillNodePath: UTILITIES_SKILL_NODE_PATH,
    executionSupport: 'call-loop-only'
  };
}

function buildGenericJsonShape(pathParams: string[]): Record<string, unknown> {
  const path: Record<string, string> = {};
  for (const param of pathParams) {
    path[param] = `<${param}>`;
  }
  return {
    ...(pathParams.length ? { path } : {}),
    query: {},
    body: {}
  };
}

export function buildGenericEndpointProfile(endpoint: PublicEndpointSpec): UtilityActionProfile {
  const headers = [...endpoint.pathParams, 'query_json', 'body_json'];
  return {
    actionKey: endpoint.key,
    title: endpoint.title,
    entity: endpoint.group,
    mode: 'generic',
    endpointKey: endpoint.key,
    method: endpoint.method,
    pathTemplate: endpoint.pathTemplate,
    primaryFormat: 'csv',
    headers,
    jsonShape: buildGenericJsonShape(endpoint.pathParams),
    decodeRules: [
      `Map path parameter columns exactly: ${endpoint.pathParams.join(', ') || '(none)'}.`,
      'query_json must be a valid JSON object string or empty.',
      'body_json must be a valid JSON object string or empty.',
      'Do not guess identifiers from context.',
      'Write ambiguous rows to rejected output with reject_reason.'
    ],
    promptTemplatePath: GENERIC_PROMPT_TEMPLATE_PATH,
    skillNodePath: UTILITIES_SKILL_NODE_PATH,
    executionSupport: 'call-loop-only'
  };
}
