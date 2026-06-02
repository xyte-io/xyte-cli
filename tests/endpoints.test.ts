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
    expect(commandList?.bodyType).toBe('none');
    expect(commandList?.hasBody).toBe(false);

    const orgInfo = endpoints.find((endpoint) => endpoint.key === 'organization.getOrganizationInfo');
    expect(orgInfo?.method).toBe('GET');
    expect(orgInfo?.hasBody).toBe(false);

    const cancelCommand = endpoints.find((endpoint) => endpoint.key === 'organization.commands.cancelCommand');
    expect(cancelCommand?.hasBody).toBe(false);

    const orgTicket = endpoints.find((endpoint) => endpoint.key === 'organization.tickets.getTicket');
    expect(orgTicket?.method).toBe('GET');
    expect(orgTicket?.bodyType).toBe('none');
    expect(orgTicket?.hasBody).toBe(false);

    const partnerTicket = endpoints.find((endpoint) => endpoint.key === 'partner.tickets.getTicket');
    expect(partnerTicket?.pathTemplate).toBe('/core/v1/partner/tickets/:ticket_id');
    expect(partnerTicket?.pathParams).toEqual(['ticket_id']);
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

  it('includes organization merge and split device endpoint metadata', () => {
    const merge = endpoints.find((item) => item.key === 'organization.devices.mergeDevice');
    expect(merge).toBeDefined();
    expect(merge?.method).toBe('POST');
    expect(merge?.pathTemplate).toBe('/core/v1/organization/devices/:device_id/merge');
    expect(merge?.authScope).toBe('organization');
    expect(merge?.bodyType).toBe('json');
    expect(merge?.hasBody).toBe(true);
    expect(merge?.pathParams).toEqual(['device_id']);
    expect(merge?.queryParams).toEqual([]);
    expect(merge?.bodyExample).toContain('with_device_ids');
    expect(merge?.sourceFile).toBe('https://docs.xyte.io/reference/merge-device');

    const split = endpoints.find((item) => item.key === 'organization.devices.splitDevice');
    expect(split).toBeDefined();
    expect(split?.method).toBe('POST');
    expect(split?.pathTemplate).toBe('/core/v1/organization/devices/:device_id/split');
    expect(split?.authScope).toBe('organization');
    expect(split?.bodyType).toBe('json');
    expect(split?.hasBody).toBe(true);
    expect(split?.pathParams).toEqual(['device_id']);
    expect(split?.queryParams).toEqual([]);
    expect(split?.bodyExample).toContain('shadow_device_id');
    expect(split?.sourceFile).toBe('https://docs.xyte.io/reference/split-device');
  });

  it('includes newly supported organization device incident controls', () => {
    const suspend = endpoints.find((item) => item.key === 'organization.devices.suspendIncidents');
    expect(suspend).toBeDefined();
    expect(suspend?.method).toBe('POST');
    expect(suspend?.pathTemplate).toBe('/core/v1/organization/devices/:device_id/suspend_incidents');
    expect(suspend?.pathParams).toEqual(['device_id']);
    expect(suspend?.bodyType).toBe('none');
    expect(suspend?.hasBody).toBe(false);
    expect(suspend?.sourceFile).toBe('https://docs.xyte.io/reference/suspend-incidents');

    const resume = endpoints.find((item) => item.key === 'organization.devices.resumeIncidents');
    expect(resume).toBeDefined();
    expect(resume?.method).toBe('POST');
    expect(resume?.pathTemplate).toBe('/core/v1/organization/devices/:device_id/resume_incidents');
    expect(resume?.pathParams).toEqual(['device_id']);
    expect(resume?.bodyType).toBe('none');
    expect(resume?.hasBody).toBe(false);
    expect(resume?.sourceFile).toBe('https://docs.xyte.io/reference/resume-incidents');
  });

  it('does not include stale PR aliases for endpoints already represented on main', () => {
    expect(endpoints.some((item) => item.key === 'organization.incidents.deleteIncident')).toBe(false);
    expect(endpoints.some((item) => item.key === 'organization.edges.startClaim')).toBe(false);
    expect(endpoints.some((item) => item.key === 'organization.edges.getClaimStatus')).toBe(false);
    expect(endpoints.some((item) => item.key === 'organization.edges.startPing')).toBe(false);
    expect(endpoints.some((item) => item.key === 'organization.edges.getPingStatus')).toBe(false);
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

    const getEdges = endpoints.find((item) => item.key === 'organization.edges.getEdges');
    expect(getEdges?.queryParams).toEqual(['page', 'per_page']);

    const getGroups = endpoints.find((item) => item.key === 'organization.groups.getGroups');
    expect(getGroups?.queryParams).toEqual(['page', 'per_page']);

    const getUsers = endpoints.find((item) => item.key === 'organization.users.getUsers');
    expect(getUsers?.queryParams).toEqual(['page', 'per_page']);
  });

  it('includes organization edge startClaim endpoint metadata', () => {
    const endpoint = endpoints.find((item) => item.key === 'organization.edge.startClaim');
    expect(endpoint).toBeDefined();
    expect(endpoint?.method).toBe('POST');
    expect(endpoint?.pathTemplate).toBe('/core/v1/organization/edges/devices/start_claim');
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
    expect(endpoint?.pathTemplate).toBe('/core/v1/organization/edges/devices/get_claim_status');
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
    expect(endpoint?.pathTemplate).toBe('/core/v1/organization/edges/devices/start_ping');
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
    expect(endpoint?.pathTemplate).toBe('/core/v1/organization/edges/devices/get_ping_status');
    expect(endpoint?.authScope).toBe('organization');
    expect(endpoint?.bodyType).toBe('none');
    expect(endpoint?.hasBody).toBe(false);
    expect(endpoint?.pathParams).toEqual([]);
    expect(endpoint?.queryParams).toEqual(['proxy_id', 'device_ip']);
    expect(endpoint?.sourceFile).toBe('https://docs.xyte.io/reference/edgeget-ping-status');
  });

  it('includes organization edge collection endpoint metadata', () => {
    const endpoint = endpoints.find((item) => item.key === 'organization.edges.getEdges');
    expect(endpoint).toBeDefined();
    expect(endpoint?.method).toBe('GET');
    expect(endpoint?.pathTemplate).toBe('/core/v1/organization/edges');
    expect(endpoint?.authScope).toBe('organization');
    expect(endpoint?.bodyType).toBe('none');
    expect(endpoint?.hasBody).toBe(false);
    expect(endpoint?.pathParams).toEqual([]);
    expect(endpoint?.queryParams).toEqual(['page', 'per_page']);
  });

  it('includes organization users and groups endpoint metadata', () => {
    const getUsers = endpoints.find((item) => item.key === 'organization.users.getUsers');
    expect(getUsers).toBeDefined();
    expect(getUsers?.method).toBe('GET');
    expect(getUsers?.pathTemplate).toBe('/core/v1/organization/users');
    expect(getUsers?.bodyType).toBe('none');
    expect(getUsers?.hasBody).toBe(false);

    const createUser = endpoints.find((item) => item.key === 'organization.users.createUser');
    expect(createUser?.method).toBe('POST');
    expect(createUser?.pathTemplate).toBe('/core/v1/organization/users');
    expect(createUser?.bodyType).toBe('json');
    expect(createUser?.hasBody).toBe(true);

    const resendWelcome = endpoints.find((item) => item.key === 'organization.users.resendWelcome');
    expect(resendWelcome?.method).toBe('POST');
    expect(resendWelcome?.pathTemplate).toBe('/core/v1/organization/users/:id/resend_welcome');
    expect(resendWelcome?.bodyType).toBe('none');
    expect(resendWelcome?.hasBody).toBe(false);

    const getGroups = endpoints.find((item) => item.key === 'organization.groups.getGroups');
    expect(getGroups).toBeDefined();
    expect(getGroups?.method).toBe('GET');
    expect(getGroups?.pathTemplate).toBe('/core/v1/organization/groups');
    expect(getGroups?.bodyType).toBe('none');
    expect(getGroups?.hasBody).toBe(false);

    const addUsers = endpoints.find((item) => item.key === 'organization.groups.addUsers');
    expect(addUsers?.method).toBe('POST');
    expect(addUsers?.pathTemplate).toBe('/core/v1/organization/groups/:id/add_users');
    expect(addUsers?.bodyType).toBe('json');
    expect(addUsers?.hasBody).toBe(true);
  });

  it('includes partner organization creation endpoint metadata', () => {
    const endpoint = endpoints.find((item) => item.key === 'partner.organizations.createOrganization');
    expect(endpoint).toBeDefined();
    expect(endpoint?.method).toBe('POST');
    expect(endpoint?.pathTemplate).toBe('/core/v1/partner/organizations');
    expect(endpoint?.authScope).toBe('partner');
    expect(endpoint?.bodyType).toBe('json');
    expect(endpoint?.hasBody).toBe(true);
    expect(endpoint?.pathParams).toEqual([]);
    expect(endpoint?.queryParams).toEqual([]);
  });
});
