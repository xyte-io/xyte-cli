import { describe, expect, it } from 'vitest';

import endpoints from '../src/api-catalog/public-endpoints.json';

describe('public endpoint catalog', () => {
  it('maps every key uniquely', () => {
    const keys = endpoints.map((endpoint) => endpoint.key);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
    expect(keys.length).toBeGreaterThan(0);
  });

  it('contains route drift overrides', () => {
    const commandList = endpoints.find((endpoint) => endpoint.key === 'organization.commands.getCommands');
    expect(commandList?.pathTemplate).toBe('/core/v1/organization/devices/:device_id/commands');

    const orgInfo = endpoints.find((endpoint) => endpoint.key === 'organization.getOrganizationInfo');
    expect(orgInfo?.method).toBe('GET');
    expect(orgInfo?.hasBody).toBe(false);

    const cancelCommand = endpoints.find((endpoint) => endpoint.key === 'organization.commands.cancelCommand');
    expect(cancelCommand?.hasBody).toBe(false);
  });

  it('contains no device namespace or device auth scope endpoints', () => {
    const deviceNamespace = endpoints.filter((endpoint) => (endpoint as { namespace: string }).namespace === 'device');
    const deviceScope = endpoints.filter((endpoint) => (endpoint as { authScope: string }).authScope === 'device');
    expect(deviceNamespace).toHaveLength(0);
    expect(deviceScope).toHaveLength(0);
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

  it('includes organization update device endpoint metadata', () => {
    const endpoint = endpoints.find((item) => item.key === 'organization.devices.updateDevice');
    expect(endpoint).toBeDefined();
    expect(endpoint?.method).toBe('PATCH');
    expect(endpoint?.pathTemplate).toBe('/core/v1/organization/devices/:device_id');
    expect(endpoint?.authScope).toBe('organization');
    expect(endpoint?.bodyType).toBe('json');
    expect(endpoint?.hasBody).toBe(true);
    expect(endpoint?.pathParams).toEqual(['device_id']);
  });

  it('includes organization move device endpoint metadata', () => {
    const endpoint = endpoints.find((item) => item.key === 'organization.devices.moveDevice');
    expect(endpoint).toBeDefined();
    expect(endpoint?.method).toBe('POST');
    expect(endpoint?.pathTemplate).toBe('/core/v1/organization/devices/:device_id/move');
    expect(endpoint?.authScope).toBe('organization');
    expect(endpoint?.bodyType).toBe('json');
    expect(endpoint?.hasBody).toBe(true);
    expect(endpoint?.pathParams).toEqual(['device_id']);
    expect(endpoint?.queryParams).toEqual([]);
    expect(endpoint?.bodyExample).toContain('"space_id": 99592');
    expect(endpoint?.sourceFile).toBe('https://docs.xyte.io/reference/move-device');
  });

  it('includes documented filter params for key read endpoints', () => {
    const getDevices = endpoints.find((item) => item.key === 'organization.devices.getDevices');
    expect(getDevices?.queryParams).toEqual(['space_id']);

    const getHistories = endpoints.find((item) => item.key === 'organization.devices.getHistories');
    expect(getHistories?.queryParams).toEqual(['status', 'from', 'to', 'device_id', 'space_id', 'name']);

    const getIncidents = endpoints.find((item) => item.key === 'organization.incidents.getIncidents');
    expect(getIncidents?.queryParams).toEqual([
      'from',
      'to',
      'status',
      'priority',
      'title',
      'description',
      'issue',
      'device_model',
      'partner_name',
      'sub_model',
      'space_id',
      'page',
      'per_page'
    ]);

    const getSpaces = endpoints.find((item) => item.key === 'organization.spaces.getSpaces');
    expect(getSpaces?.queryParams).toEqual([
      'id',
      'name',
      'parent_id',
      'space_type',
      'created_before',
      'created_after',
      'path_includes'
    ]);
  });

  it('includes organization edge startClaim endpoint metadata', () => {
    const endpoint = endpoints.find((item) => item.key === 'organization.edge.startClaim');
    expect(endpoint).toBeDefined();
    expect(endpoint?.method).toBe('POST');
    expect(endpoint?.pathTemplate).toBe('/core/v1/organization/edge/devices/start_claim');
    expect((endpoint as { namespace: string }).namespace).toBe('organization');
    expect((endpoint as { group: string }).group).toBe('edge');
    expect(endpoint?.authScope).toBe('organization');
    expect(endpoint?.bodyType).toBe('json');
    expect(endpoint?.hasBody).toBe(true);
    expect(endpoint?.pathParams).toEqual([]);
    expect(endpoint?.queryParams).toEqual([]);
    expect(endpoint?.bodyExample).toContain('proxy_id');
    expect(endpoint?.bodyExample).toContain('device_ip');
    expect(endpoint?.bodyExample).toContain('device_model_id');
    expect(endpoint?.bodyExample).toContain('space_id');
    expect(endpoint?.sourceFile).toBe('https://docs.xyte.io/reference/edgeclaim-device');
  });

  it('includes organization edge getClaimStatus endpoint metadata', () => {
    const endpoint = endpoints.find((item) => item.key === 'organization.edge.getClaimStatus');
    expect(endpoint).toBeDefined();
    expect(endpoint?.method).toBe('GET');
    expect(endpoint?.pathTemplate).toBe('/core/v1/organization/edge/devices/get_claim_status');
    expect(endpoint?.authScope).toBe('organization');
    expect(endpoint?.bodyType).toBe('none');
    expect(endpoint?.hasBody).toBe(false);
    expect(endpoint?.pathParams).toEqual([]);
    expect(endpoint?.queryParams).toEqual(['proxy_id', 'device_ip']);
    expect(endpoint?.sourceFile).toBe('https://docs.xyte.io/reference/edgeget-claim-status');
  });

  it('includes organization edge startPing endpoint metadata', () => {
    const endpoint = endpoints.find((item) => item.key === 'organization.edge.startPing');
    expect(endpoint).toBeDefined();
    expect(endpoint?.method).toBe('POST');
    expect(endpoint?.pathTemplate).toBe('/core/v1/organization/edge/devices/start_ping');
    expect(endpoint?.authScope).toBe('organization');
    expect(endpoint?.bodyType).toBe('json');
    expect(endpoint?.hasBody).toBe(true);
    expect(endpoint?.pathParams).toEqual([]);
    expect(endpoint?.queryParams).toEqual([]);
    expect(endpoint?.bodyExample).toContain('proxy_id');
    expect(endpoint?.bodyExample).toContain('device_ip');
    expect(endpoint?.sourceFile).toBe('https://docs.xyte.io/reference/edgestart-ping');
  });

  it('includes organization edge getPingStatus endpoint metadata', () => {
    const endpoint = endpoints.find((item) => item.key === 'organization.edge.getPingStatus');
    expect(endpoint).toBeDefined();
    expect(endpoint?.method).toBe('GET');
    expect(endpoint?.pathTemplate).toBe('/core/v1/organization/edge/devices/get_ping_status');
    expect(endpoint?.authScope).toBe('organization');
    expect(endpoint?.bodyType).toBe('none');
    expect(endpoint?.hasBody).toBe(false);
    expect(endpoint?.pathParams).toEqual([]);
    expect(endpoint?.queryParams).toEqual(['proxy_id', 'device_ip']);
    expect(endpoint?.sourceFile).toBe('https://docs.xyte.io/reference/edgeget-ping-status');
  });
});
