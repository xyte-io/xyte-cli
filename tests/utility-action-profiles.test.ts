import { describe, expect, it } from 'vitest';

import {
  buildFriendlySpaceImportProfile,
  buildFriendlyClaimDeviceProfile,
  buildFriendlyMoveDeviceProfile,
  buildGenericEndpointProfile
} from '../src/workflows/utility-action-profiles';
import type { PublicEndpointSpec } from '../src/types/endpoints';

function makeEndpoint(overrides: Partial<PublicEndpointSpec> = {}): PublicEndpointSpec {
  return {
    key: 'organization.devices.claimDevice',
    namespace: 'organization',
    group: 'devices',
    action: 'claimDevice',
    title: 'Claim Device',
    method: 'POST',
    base: 'hub',
    pathTemplate: '/core/v1/organization/devices/claim',
    pathParams: [],
    queryParams: [],
    authScope: 'organization',
    bodyType: 'json',
    hasBody: true,
    sourceFile: 'test',
    ...overrides
  };
}

describe('utility-action-profiles', () => {
  describe('buildFriendlySpaceImportProfile', () => {
    it('returns a valid profile with expected fields', () => {
      const profile = buildFriendlySpaceImportProfile();
      expect(profile.actionKey).toBe('space.import-tree');
      expect(profile.mode).toBe('friendly');
      expect(profile.primaryFormat).toBe('csv');
      expect(profile.headers).toContain('path');
      expect(profile.executionSupport).toBe('space.import-tree');
    });
  });

  describe('buildFriendlyClaimDeviceProfile', () => {
    it('uses endpoint fields', () => {
      const endpoint = makeEndpoint({ key: 'organization.devices.claim', title: 'Claim', group: 'devices' });
      const profile = buildFriendlyClaimDeviceProfile(endpoint);
      expect(profile.actionKey).toBe('organization.devices.claim');
      expect(profile.title).toBe('Claim');
      expect(profile.entity).toBe('devices');
      expect(profile.mode).toBe('friendly');
      expect(profile.executionSupport).toBe('call-loop-only');
    });

    it('includes required CSV headers', () => {
      const profile = buildFriendlyClaimDeviceProfile(makeEndpoint());
      expect(profile.headers).toContain('name');
      expect(profile.headers).toContain('sn');
    });
  });

  describe('buildFriendlyMoveDeviceProfile', () => {
    it('always uses device.move actionKey', () => {
      const profile = buildFriendlyMoveDeviceProfile(makeEndpoint());
      expect(profile.actionKey).toBe('device.move');
      expect(profile.executionSupport).toBe('device.move');
    });

    it('includes required CSV headers', () => {
      const profile = buildFriendlyMoveDeviceProfile(makeEndpoint());
      expect(profile.headers).toContain('device_id');
      expect(profile.headers).toContain('target_space_id');
    });
  });

  describe('buildGenericEndpointProfile', () => {
    it('returns generic mode profile', () => {
      const profile = buildGenericEndpointProfile(makeEndpoint());
      expect(profile.mode).toBe('generic');
      expect(profile.headers).toContain('query_json');
      expect(profile.headers).toContain('body_json');
    });

    it('includes path params in headers and jsonShape', () => {
      const profile = buildGenericEndpointProfile(makeEndpoint({ pathParams: ['device_id'] }));
      expect(profile.headers).toContain('device_id');
      expect((profile.jsonShape.path as Record<string, string>)['device_id']).toBe('<device_id>');
    });

    it('omits path key from jsonShape when no path params', () => {
      const profile = buildGenericEndpointProfile(makeEndpoint({ pathParams: [] }));
      expect(profile.jsonShape.path).toBeUndefined();
    });
  });
});
