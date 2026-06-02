import type { PublicEndpointSpec } from '../types/endpoints';

export type UtilityPreparePrimaryFormat = 'csv' | 'jsonl';
export type UtilityPrepareMode = 'friendly' | 'generic';
export type UtilityExecutionSupport =
  | 'space.import-tree'
  | 'device.move'
  | 'edge.claim-batch'
  | 'prepare-only'
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

const SUPPORTED_CONNECTOR_NAMES = [
  'zoom_v2',
  'mtr',
  'biamp_workplace',
  'bright_sign_v2',
  'xio_v2',
  'domotz',
  'neat',
  'q_sys_v2',
  'sony_c2c',
  'logitech_sync',
  'poly_lens',
  'cisco_control_hub',
  'app_space',
  'shure',
  'netgear',
  'yealink'
];

const GENERIC_PROMPT_TEMPLATE_PATH = 'skills/xyte-cli/templates/ai-utility-prepare-generic.prompt.md';
const SPACE_IMPORT_PROMPT_TEMPLATE_PATH = 'skills/xyte-cli/templates/ai-space-import.prompt.md';
const UTILITIES_SKILL_NODE_PATH = 'skills/xyte-cli/references/utilities.md';
const SPACE_IMPORT_SKILL_NODE_PATH = 'skills/xyte-cli/references/utility-ai-space-import-tree.md';

export function buildFriendlyConnectorSetupProfile(): UtilityActionProfile {
  return {
    actionKey: 'organization.connectors.prepareSetup',
    title: 'Connector Setup Prepare',
    entity: 'connectors',
    mode: 'friendly',
    primaryFormat: 'csv',
    headers: [
      'label',
      'platform',
      'connectorName',
      'targetSpace',
      'targetSpaceId',
      'authorizationOwner',
      'deviceNameSource',
      'sourceRow',
      'notes'
    ],
    jsonShape: {
      label: 'Zoom Rooms',
      platform: 'Zoom Rooms',
      connectorName: 'zoom_v2',
      targetSpace: 'Milan HQ/Lobby',
      targetSpaceId: '',
      authorizationOwner: 'AV operations team',
      deviceNameSource: 'xyte_managed',
      sourceRow: '2',
      notes: ''
    },
    decodeRules: [
      'Map source rows into label,platform,connectorName,targetSpace,targetSpaceId,authorizationOwner,deviceNameSource,sourceRow,notes columns.',
      `connectorName must be one of: ${SUPPORTED_CONNECTOR_NAMES.join(', ')}.`,
      'targetSpace is required and must be non-empty.',
      'authorizationOwner is required and must be non-empty.',
      'targetSpaceId is optional; leave blank unless the source explicitly has a real id.',
      'deviceNameSource defaults to xyte_managed when absent.',
      'Reject rows when connector/platform cannot map to a supported connectorName.',
      'Write unresolved rows to rejected output with reject_reason.'
    ],
    promptTemplatePath: GENERIC_PROMPT_TEMPLATE_PATH,
    skillNodePath: UTILITIES_SKILL_NODE_PATH,
    executionSupport: 'prepare-only'
  };
}

export function buildFriendlyTeamAccessGroupsProfile(): UtilityActionProfile {
  return {
    actionKey: 'organization.teamAccess.groups',
    title: 'Team Access Groups Prepare',
    entity: 'teamAccess',
    mode: 'friendly',
    primaryFormat: 'csv',
    headers: ['label', 'groupName', 'iconName', 'sourceRow', 'notes'],
    jsonShape: {
      label: 'AV operations',
      groupName: 'AV operations',
      iconName: 'users',
      sourceRow: '2',
      notes: ''
    },
    decodeRules: [
      'Map source rows into label,groupName,iconName,sourceRow,notes columns.',
      'groupName is required and must be non-empty.',
      'iconName defaults to users when absent.',
      'Deduplicate groups by normalized groupName.',
      'Write unresolved rows to rejected output with reject_reason.'
    ],
    promptTemplatePath: GENERIC_PROMPT_TEMPLATE_PATH,
    skillNodePath: UTILITIES_SKILL_NODE_PATH,
    executionSupport: 'prepare-only'
  };
}

export function buildFriendlyTeamAccessUsersProfile(): UtilityActionProfile {
  return {
    actionKey: 'organization.teamAccess.users',
    title: 'Team Access User Invites Prepare',
    entity: 'teamAccess',
    mode: 'friendly',
    primaryFormat: 'csv',
    headers: ['label', 'email', 'name', 'groupName', 'assignSupportSeat', 'sourceRow', 'notes'],
    jsonShape: {
      label: 'Dana Cohen',
      email: 'dana@example.com',
      name: 'Dana Cohen',
      groupName: 'AV operations',
      assignSupportSeat: '',
      sourceRow: '2',
      notes: ''
    },
    decodeRules: [
      'Map source rows into label,email,name,groupName,assignSupportSeat,sourceRow,notes columns.',
      'email is required and must be non-empty.',
      'name is optional.',
      'groupName is required when the source row assigns the user to a group.',
      'Do not invent emails.',
      'Reject rows with email but unclear group when the intended output requires group context.',
      'Write unresolved rows to rejected output with reject_reason.'
    ],
    promptTemplatePath: GENERIC_PROMPT_TEMPLATE_PATH,
    skillNodePath: UTILITIES_SKILL_NODE_PATH,
    executionSupport: 'prepare-only'
  };
}

export function buildFriendlyTeamAccessMembershipsProfile(): UtilityActionProfile {
  return {
    actionKey: 'organization.teamAccess.memberships',
    title: 'Team Access Memberships Prepare',
    entity: 'teamAccess',
    mode: 'friendly',
    primaryFormat: 'csv',
    headers: ['label', 'email', 'groupName', 'sourceRow', 'notes'],
    jsonShape: {
      label: 'Dana Cohen in AV operations',
      email: 'dana@example.com',
      groupName: 'AV operations',
      sourceRow: '2',
      notes: ''
    },
    decodeRules: [
      'Map source rows into label,email,groupName,sourceRow,notes columns.',
      'email is required and must be non-empty.',
      'groupName is required and must be non-empty.',
      'Emit membership rows for users assigned to groups.',
      'If the same source row creates the user and assigns them, prepare both a users row and a memberships row through the separate utilities.',
      'Write unresolved rows to rejected output with reject_reason.'
    ],
    promptTemplatePath: GENERIC_PROMPT_TEMPLATE_PATH,
    skillNodePath: UTILITIES_SKILL_NODE_PATH,
    executionSupport: 'prepare-only'
  };
}

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
