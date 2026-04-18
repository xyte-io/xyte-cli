import { listEndpoints } from '../client/catalog';
import type { PublicEndpointSpec } from '../types/endpoints';
import { CliUserError } from '../contracts/user-error';
import {
  buildFriendlyClaimDeviceProfile,
  buildFriendlyEdgeClaimProfile,
  buildFriendlyMoveDeviceProfile,
  buildFriendlySpaceImportProfile,
  buildGenericEndpointProfile,
  type UtilityActionProfile
} from './utility-action-profiles';

const WRITE_METHODS = new Set<PublicEndpointSpec['method']>(['POST', 'PUT', 'PATCH', 'DELETE']);

function loadWriteEndpoints(): PublicEndpointSpec[] {
  return listEndpoints().filter((endpoint) => WRITE_METHODS.has(endpoint.method));
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
    if (endpoint.key === 'organization.edge.startClaim') {
      profiles.set(endpoint.key, buildFriendlyEdgeClaimProfile(endpoint));
      continue;
    }
    if (endpoint.key === 'organization.devices.moveDevice') {
      profiles.set('device.move', buildFriendlyMoveDeviceProfile(endpoint));
    }
    profiles.set(endpoint.key, buildGenericEndpointProfile(endpoint));
  }

  return Array.from(profiles.values()).sort((left, right) => left.actionKey.localeCompare(right.actionKey));
}

let _actionProfiles: UtilityActionProfile[] | undefined;
function getActionProfiles(): UtilityActionProfile[] {
  if (!_actionProfiles) {
    _actionProfiles = buildProfiles();
  }
  return _actionProfiles;
}

interface ListUtilityActionOptions {
  entity?: string;
  includeGeneric?: boolean;
}

export function listUtilityActionProfiles(options: ListUtilityActionOptions = {}): UtilityActionProfile[] {
  const includeGeneric = options.includeGeneric !== false;
  const requestedEntity = options.entity?.trim().toLowerCase();
  return getActionProfiles().filter((profile) => {
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
  const found = getActionProfiles().find((profile) => profile.actionKey === normalized);
  if (!found) {
    throw new CliUserError({ summary: `Unknown utility action: ${actionKey}` });
  }
  return found;
}
