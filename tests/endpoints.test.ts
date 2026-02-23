import { describe, expect, it } from 'vitest';

import endpoints from '../src/spec/public-endpoints.json';

describe('public endpoint catalog', () => {
  it('maps every key uniquely', () => {
    const keys = endpoints.map((endpoint) => endpoint.key);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
    expect(keys.length).toBeGreaterThan(60);
  });

  it('contains route drift overrides', () => {
    const commandList = endpoints.find((endpoint) => endpoint.key === 'organization.commands.getCommands');
    expect(commandList?.pathTemplate).toBe('/core/v1/organization/devices/:device_id/commands');

    const orgInfo = endpoints.find((endpoint) => endpoint.key === 'organization.getOrganizationInfo');
    expect(orgInfo?.method).toBe('GET');
    expect(orgInfo?.hasBody).toBe(false);

    const cancelCommand = endpoints.find((endpoint) => endpoint.key === 'organization.commands.cancelCommand');
    expect(cancelCommand?.hasBody).toBe(false);

    const cloudSettings = endpoints.find((endpoint) => endpoint.key === 'device.device-info.setCloudSettings');
    expect(cloudSettings?.notes?.join(' ')).toContain('{ property, value }');
  });

  it('includes device space move endpoint metadata', () => {
    const endpoint = endpoints.find((item) => item.key === 'device.device-info.spaceMove');
    expect(endpoint).toBeDefined();
    expect(endpoint?.method).toBe('PUT');
    expect(endpoint?.pathTemplate).toBe('/v1/devices/:device_id/space/:space_id');
    expect(endpoint?.authScope).toBe('device');
    expect(endpoint?.bodyType).toBe('none');
    expect(endpoint?.hasBody).toBe(false);
    expect(endpoint?.pathParams).toEqual(['device_id', 'space_id']);
  });

  it('includes organization close incident endpoint metadata', () => {
    const endpoint = endpoints.find((item) => item.key === 'organization.incidents.closeIncident');
    expect(endpoint).toBeDefined();
    expect(endpoint?.method).toBe('DELETE');
    expect(endpoint?.pathTemplate).toBe('/core/v1/organization/incidents/:incident_id');
    expect(endpoint?.authScope).toBe('organization');
    expect(endpoint?.bodyType).toBe('none');
    expect(endpoint?.hasBody).toBe(false);
    expect(endpoint?.pathParams).toEqual(['incident_id']);
  });
});
