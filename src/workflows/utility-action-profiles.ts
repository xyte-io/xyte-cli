import type { PublicEndpointSpec } from '../types/endpoints';

export type UtilityPreparePrimaryFormat = 'csv' | 'jsonl';
export type UtilityPrepareMode = 'friendly' | 'generic';
export type UtilityExecutionSupport =
  | 'space.import-tree'
  | 'device.move'
  | 'edge.claim-batch'
  | 'call-loop-only';

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

const GENERIC_PROMPT_TEMPLATE_PATH = 'skills/xyte-cli/templates/ai-utility-prepare-generic.prompt.md';
const SPACE_IMPORT_PROMPT_TEMPLATE_PATH = 'skills/xyte-cli/templates/ai-space-import.prompt.md';
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

export function buildFriendlyEdgeClaimProfile(endpoint: PublicEndpointSpec): UtilityActionProfile {
  return {
    actionKey: endpoint.key,
    title: endpoint.title,
    entity: endpoint.group,
    mode: 'friendly',
    endpointKey: endpoint.key,
    method: endpoint.method,
    pathTemplate: endpoint.pathTemplate,
    primaryFormat: 'csv',
    headers: [
      'proxy_id',
      'device_ip',
      'device_model_id',
      'space_id',
      'display_name',
      'custom_parameters',
      'custom_partner_name',
      'custom_model_name',
      'skip_connectivity_check'
    ],
    jsonShape: {
      proxy_id: 'proxy-uuid',
      device_ip: '192.168.1.100',
      device_model_id: 'model-uuid',
      space_id: 10000,
      display_name: 'Conference Room Display',
      custom_parameters: {},
      custom_partner_name: '',
      custom_model_name: '',
      skip_connectivity_check: false
    },
    decodeRules: [
      'Map source rows into proxy_id,device_ip,device_model_id,space_id,display_name,custom_parameters,custom_partner_name,custom_model_name,skip_connectivity_check columns.',
      'proxy_id, device_ip, device_model_id, and space_id are required and must be non-empty.',
      'space_id must stay numeric so the claim endpoint receives an integer space_id.',
      'device_ip must parse as an IPv4/IPv6 address or a resolvable hostname; reject rows that do not.',
      'skip_connectivity_check, when present, must be the literal "true" or "false" (case-insensitive); blank means the batch runner performs a pre-claim ping before startClaim.',
      'custom_parameters, when present, must be a valid JSON object string or empty.',
      'Do not guess proxy_id or device_model_id from context; reject ambiguous rows.',
      'Write unresolved rows to rejected output with reject_reason.'
    ],
    promptTemplatePath: GENERIC_PROMPT_TEMPLATE_PATH,
    skillNodePath: UTILITIES_SKILL_NODE_PATH,
    executionSupport: 'edge.claim-batch'
  };
}

export function buildFriendlyMoveDeviceProfile(endpoint: PublicEndpointSpec): UtilityActionProfile {
  return {
    actionKey: 'device.move',
    title: endpoint.title,
    entity: endpoint.group,
    mode: 'friendly',
    endpointKey: endpoint.key,
    method: endpoint.method,
    pathTemplate: endpoint.pathTemplate,
    primaryFormat: 'csv',
    headers: ['device_id', 'target_space_id', 'device_name', 'current_space_id', 'target_space_name'],
    jsonShape: {
      device_id: '12345',
      target_space_id: 99592,
      device_name: 'South Wing Display',
      current_space_id: 55123,
      target_space_name: 'South Wing'
    },
    decodeRules: [
      'Map source rows into device_id,target_space_id,device_name,current_space_id,target_space_name columns.',
      'device_id and target_space_id are required and must be non-empty.',
      'target_space_id must stay numeric so the move endpoint receives an integer space_id.',
      'Do not guess device ids or target spaces; reject ambiguous rows.',
      'Write unresolved rows to rejected output with reject_reason.'
    ],
    promptTemplatePath: GENERIC_PROMPT_TEMPLATE_PATH,
    skillNodePath: UTILITIES_SKILL_NODE_PATH,
    executionSupport: 'device.move'
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
