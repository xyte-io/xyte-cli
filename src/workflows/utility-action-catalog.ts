import rawEndpoints from '../spec/public-endpoints.json';
import type { PublicEndpointSpec } from '../types/endpoints';
import {
  buildFriendlyClaimDeviceProfile,
  buildFriendlySpaceImportProfile,
  buildGenericEndpointProfile,
  type UtilityActionProfile
} from './utility-action-profiles';

const WRITE_METHODS = new Set<PublicEndpointSpec['method']>(['POST', 'PUT', 'PATCH', 'DELETE']);

function loadWriteEndpoints(): PublicEndpointSpec[] {
  return (rawEndpoints as PublicEndpointSpec[]).filter((endpoint) => WRITE_METHODS.has(endpoint.method));
}

function endpointKeyComparator(left: PublicEndpointSpec, right: PublicEndpointSpec): number {
  return left.key.localeCompare(right.key);
}

function buildProfiles(): UtilityActionProfile[] {
  const profiles = new Map<string, UtilityActionProfile>();

  profiles.set('space.import-tree', buildFriendlySpaceImportProfile());

  const writeEndpoints = loadWriteEndpoints().sort(endpointKeyComparator);
  for (const endpoint of writeEndpoints) {
    if (endpoint.key === 'organization.devices.claimDevice') {
      profiles.set(endpoint.key, buildFriendlyClaimDeviceProfile(endpoint));
      continue;
    }
    profiles.set(endpoint.key, buildGenericEndpointProfile(endpoint));
  }

  return Array.from(profiles.values()).sort((left, right) => left.actionKey.localeCompare(right.actionKey));
}

const ACTION_PROFILES = buildProfiles();

interface ListUtilityActionOptions {
  entity?: string;
  includeGeneric?: boolean;
}

export function listUtilityActionProfiles(options: ListUtilityActionOptions = {}): UtilityActionProfile[] {
  const includeGeneric = options.includeGeneric !== false;
  const requestedEntity = options.entity?.trim().toLowerCase();
  return ACTION_PROFILES.filter((profile) => {
    if (!includeGeneric && profile.mode === 'generic') {
      return false;
    }
    if (requestedEntity && profile.entity.toLowerCase() !== requestedEntity) {
      return false;
    }
    return true;
  });
}

export function getUtilityActionProfile(actionKey: string): UtilityActionProfile {
  const normalized = actionKey.trim();
  const found = ACTION_PROFILES.find((profile) => profile.actionKey === normalized);
  if (!found) {
    throw new Error(`Unknown utility action: ${actionKey}`);
  }
  return found;
}
