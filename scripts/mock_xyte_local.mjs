#!/usr/bin/env node

import http from 'node:http';
import { URL } from 'node:url';

function parseArgs(argv) {
  const args = {
    host: '127.0.0.1',
    port: 3001,
    strictAuth: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--host') {
      args.host = argv[index + 1] ?? args.host;
      index += 1;
      continue;
    }
    if (token === '--port') {
      const parsed = Number.parseInt(argv[index + 1] ?? '', 10);
      if (Number.isFinite(parsed)) {
        args.port = parsed;
      }
      index += 1;
      continue;
    }
    if (token === '--strict-auth') {
      args.strictAuth = true;
    }
  }

  return args;
}

function isoHoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function makeInitialState() {
  const rootSpace = {
    id: 1,
    name: 'Overview',
    path: 'Overview',
    full_path: 'Overview',
    parent_id: null,
    space_type: 'root',
    config: {},
    created_at: isoHoursAgo(240)
  };
  const defaultSpace = {
    id: 2,
    name: 'Default',
    path: 'Overview/Default',
    full_path: 'Overview/Default',
    parent_id: 1,
    space_type: 'customer',
    config: {},
    created_at: isoHoursAgo(120)
  };
  const labSpace = {
    id: 3,
    name: 'Lab',
    path: 'Overview/Lab',
    full_path: 'Overview/Lab',
    parent_id: 1,
    space_type: 'room',
    config: {},
    created_at: isoHoursAgo(72)
  };

  const devices = [
    {
      id: 'd1',
      name: 'Device One',
      status: 'online',
      partner_name: 'Mock Partner',
      model: 'Mock Display',
      sub_model: 'Series A',
      space_id: 2,
      created_at: isoHoursAgo(96)
    },
    {
      id: 'd2',
      name: 'Device Two',
      status: 'offline',
      partner_name: 'Mock Partner',
      model: 'Mock Sensor',
      sub_model: 'Series B',
      space_id: 3,
      created_at: isoHoursAgo(48)
    }
  ];

  const incidents = [
    {
      id: 'inc-1',
      uuid: 'inc-1',
      status: 'active',
      priority: 'high',
      title: 'Device offline',
      description: 'Mock active incident for guided remediation.',
      device_id: 'd2',
      device_name: 'Device Two',
      device_model: 'Mock Sensor',
      device_sub_model: 'Series B',
      partner_name: 'Mock Partner',
      space_id: 3,
      space_tree_path_name: 'Overview/Lab',
      space_name: 'Lab',
      issue: 'offline',
      created_at: isoHoursAgo(2),
      updated_at: isoHoursAgo(1)
    },
    {
      id: 'inc-2',
      uuid: 'inc-2',
      status: 'closed',
      priority: 'moderate',
      title: 'Recovered alert',
      description: 'Closed mock incident.',
      device_id: 'd1',
      device_name: 'Device One',
      device_model: 'Mock Display',
      device_sub_model: 'Series A',
      partner_name: 'Mock Partner',
      space_id: 2,
      space_tree_path_name: 'Overview/Default',
      space_name: 'Default',
      issue: 'user',
      created_at: isoHoursAgo(24),
      updated_at: isoHoursAgo(12)
    }
  ];

  const tickets = [
    {
      id: 't1',
      title: 'Investigate device two',
      status: 'open',
      device_id: 'd2',
      created_at: isoHoursAgo(6),
      updated_at: isoHoursAgo(2),
      messages: []
    }
  ];

  const commandsByDevice = new Map([
    [
      'd2',
      [
        {
          id: 'cmd-hist-1',
          command: 'restart',
          status: 'completed',
          created_at: isoHoursAgo(3)
        }
      ]
    ]
  ]);

  return {
    organization: {
      id: 'org-local',
      name: 'Local Mock Org'
    },
    devices: new Map(devices.map((device) => [device.id, device])),
    spacesById: new Map([
      [rootSpace.id, rootSpace],
      [defaultSpace.id, defaultSpace],
      [labSpace.id, labSpace]
    ]),
    spacesByPath: new Map([
      [rootSpace.full_path, rootSpace],
      [defaultSpace.full_path, defaultSpace],
      [labSpace.full_path, labSpace]
    ]),
    incidents: new Map(incidents.map((incident) => [incident.id, incident])),
    tickets: new Map(tickets.map((ticket) => [ticket.id, ticket])),
    commandsByDevice,
    nextSpaceId: 4,
    nextClaimedDeviceId: 3,
    nextCommandId: 2
  };
}

const options = parseArgs(process.argv.slice(2));
const strictAuthToken = process.env.XYTE_LOCAL_AUTH_TOKEN ?? 'local-key';
let state = makeInitialState();

function writeJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk.toString();
  }
  if (!raw.trim()) {
    return {};
  }
  return JSON.parse(raw);
}

function authGuard(request, response) {
  const auth = request.headers.authorization;
  if (!auth || !String(auth).trim()) {
    writeJson(response, 401, { error: 'Missing Authorization header.' });
    return false;
  }
  const headerValue = String(auth).trim();
  const match = headerValue.match(/^bearer\s+(.+)$/i);
  const token = (match ? match[1] : headerValue).trim();
  if (options.strictAuth && token !== strictAuthToken) {
    writeJson(response, 403, { error: 'Invalid Authorization token for strict-auth mode.' });
    return false;
  }
  return true;
}

function parseInteger(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function paginate(items, searchParams) {
  const page = Math.max(1, parseInteger(searchParams.get('page')) ?? 1);
  const fallbackPerPage = items.length > 0 ? items.length : 1;
  const perPage = Math.max(1, parseInteger(searchParams.get('per_page')) ?? fallbackPerPage);
  const startIndex = (page - 1) * perPage;
  const sliced = items.slice(startIndex, startIndex + perPage);
  return {
    items: sliced,
    has_next_page: startIndex + perPage < items.length,
    next_page: startIndex + perPage < items.length ? page + 1 : null
  };
}

function listSpaces(filters = {}) {
  let spaces = Array.from(state.spacesById.values()).sort((left, right) => left.id - right.id);

  if (filters.parentId !== undefined) {
    spaces = spaces.filter((space) => space.parent_id === filters.parentId);
  }
  if (filters.id !== undefined) {
    spaces = spaces.filter((space) => space.id === filters.id);
  }
  if (typeof filters.name === 'string' && filters.name.trim()) {
    const expected = filters.name.trim().toLowerCase();
    spaces = spaces.filter((space) => String(space.name).trim().toLowerCase() === expected);
  }
  if (typeof filters.pathIncludes === 'string' && filters.pathIncludes.trim()) {
    const needle = filters.pathIncludes.trim().toLowerCase();
    spaces = spaces.filter((space) => String(space.path ?? '').toLowerCase().includes(needle));
  }
  if (typeof filters.spaceType === 'string' && filters.spaceType.trim()) {
    const expectedType = filters.spaceType.trim().toLowerCase();
    spaces = spaces.filter((space) => String(space.space_type ?? '').toLowerCase() === expectedType);
  }

  return spaces;
}

function listDevices() {
  return Array.from(state.devices.values()).sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function listIncidents(filters = {}) {
  let incidents = Array.from(state.incidents.values()).sort((left, right) => String(left.id).localeCompare(String(right.id)));
  if (typeof filters.status === 'string' && filters.status.trim()) {
    const expected = filters.status.trim().toLowerCase();
    incidents = incidents.filter((incident) => String(incident.status).toLowerCase() === expected);
  }
  if (filters.spaceId !== undefined) {
    incidents = incidents.filter((incident) => incident.space_id === filters.spaceId);
  }
  return incidents;
}

function listTickets() {
  return Array.from(state.tickets.values()).sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function setDeviceName(deviceId, name) {
  const device = state.devices.get(deviceId);
  if (!device) {
    return undefined;
  }
  device.name = name;
  state.devices.set(deviceId, device);
  for (const incident of state.incidents.values()) {
    if (incident.device_id === deviceId) {
      incident.device_name = name;
      incident.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      state.incidents.set(incident.id, incident);
    }
  }
  return device;
}

function findSpaceById(spaceId) {
  return state.spacesById.get(spaceId);
}

function createClaimedDevice(body) {
  const spaceId = parseInteger(body.space_id);
  if (spaceId === undefined || !findSpaceById(spaceId)) {
    throw new Error('Body must include a valid numeric "space_id".');
  }
  const claimedId = `claimed-${state.nextClaimedDeviceId}`;
  state.nextClaimedDeviceId += 1;
  const device = {
    id: claimedId,
    name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : `Claimed ${claimedId}`,
    status: 'online',
    partner_name: 'Mock Claim',
    model: 'Mock Claimed Device',
    sub_model: null,
    space_id: spaceId,
    sn: typeof body.sn === 'string' ? body.sn : '',
    mac: typeof body.mac === 'string' ? body.mac : '',
    cloud_id: typeof body.cloud_id === 'string' ? body.cloud_id : '',
    created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  };
  state.devices.set(device.id, device);
  return device;
}

function findOrCreateSpace(body) {
  const rawName = typeof body.name === 'string' ? body.name.trim() : '';
  if (!rawName) {
    throw new Error('Body must include non-empty "name".');
  }

  const parentId = parseInteger(body.parent_id);
  if (parentId === undefined) {
    throw new Error('Body must include numeric "parent_id".');
  }

  const parent = state.spacesById.get(parentId);
  if (!parent) {
    throw new Error(`Unknown parent_id ${parentId}.`);
  }

  const fullPath = parent.full_path ? `${parent.full_path}/${rawName}` : rawName;
  const existing = state.spacesByPath.get(fullPath);
  if (existing) {
    return { ...existing, found: true };
  }

  const created = {
    id: state.nextSpaceId,
    name: rawName,
    path: fullPath,
    full_path: fullPath,
    parent_id: parentId,
    space_type: typeof body.space_type === 'string' ? body.space_type : 'space',
    config: body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {},
    created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  };
  state.nextSpaceId += 1;
  state.spacesById.set(created.id, created);
  state.spacesByPath.set(fullPath, created);
  return { ...created, found: false };
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${options.host}:${options.port}`);
  const pathname = url.pathname;
  const method = request.method ?? 'GET';

  if (pathname === '/_mock/reset' && method === 'POST') {
    state = makeInitialState();
    writeJson(response, 200, { ok: true });
    return;
  }

  if (pathname === '/_mock/state' && method === 'GET') {
    writeJson(response, 200, {
      devices: listDevices(),
      spaces: listSpaces(),
      incidents: listIncidents(),
      tickets: listTickets(),
      commands: Object.fromEntries(state.commandsByDevice.entries())
    });
    return;
  }

  if (!authGuard(request, response)) {
    return;
  }

  if (pathname === '/core/v1/organization/info' && method === 'GET') {
    writeJson(response, 200, state.organization);
    return;
  }

  if (pathname === '/core/v1/organization/devices' && method === 'GET') {
    writeJson(response, 200, paginate(listDevices(), url.searchParams));
    return;
  }

  if (pathname === '/core/v1/organization/devices/claim' && method === 'POST') {
    const body = await readJson(request);
    if (!body || typeof body !== 'object') {
      writeJson(response, 400, { error: 'Body must include claim payload.' });
      return;
    }
    let claimed;
    try {
      claimed = createClaimedDevice(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeJson(response, 422, { error: message });
      return;
    }
    writeJson(response, 200, claimed);
    return;
  }

  if (pathname === '/core/v1/organization/spaces' && method === 'GET') {
    const parentId = parseInteger(url.searchParams.get('parent_id'));
    const filters = {
      parentId,
      id: parseInteger(url.searchParams.get('id')),
      name: url.searchParams.get('name') ?? undefined,
      pathIncludes: url.searchParams.get('path_includes') ?? undefined,
      spaceType: url.searchParams.get('space_type') ?? undefined
    };
    writeJson(response, 200, paginate(listSpaces(filters), url.searchParams));
    return;
  }

  if (pathname === '/core/v1/organization/incidents' && method === 'GET') {
    const filters = {
      status: url.searchParams.get('status') ?? undefined,
      spaceId: parseInteger(url.searchParams.get('space_id'))
    };
    writeJson(response, 200, paginate(listIncidents(filters), url.searchParams));
    return;
  }

  if (pathname === '/core/v1/organization/tickets' && method === 'GET') {
    writeJson(response, 200, paginate(listTickets(), url.searchParams));
    return;
  }

  if (pathname === '/core/v1/organization/spaces/find_or_create' && method === 'POST') {
    const body = await readJson(request);
    if (!body || typeof body !== 'object') {
      writeJson(response, 400, { error: 'Body must include name and parent_id.' });
      return;
    }
    let created;
    try {
      created = findOrCreateSpace(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeJson(response, 422, { error: message });
      return;
    }
    writeJson(response, 200, created);
    return;
  }

  const deviceCommandsMatch = pathname.match(/^\/core\/v1\/organization\/devices\/([^/]+)\/commands$/);
  if (deviceCommandsMatch && method === 'GET') {
    const deviceId = decodeURIComponent(deviceCommandsMatch[1]);
    if (!state.devices.has(deviceId)) {
      writeJson(response, 404, { error: `Unknown device ${deviceId}` });
      return;
    }
    writeJson(response, 200, paginate(state.commandsByDevice.get(deviceId) ?? [], url.searchParams));
    return;
  }

  if (deviceCommandsMatch && method === 'POST') {
    const deviceId = decodeURIComponent(deviceCommandsMatch[1]);
    if (!state.devices.has(deviceId)) {
      writeJson(response, 404, { error: `Unknown device ${deviceId}` });
      return;
    }
    const body = await readJson(request);
    const command = typeof body?.command === 'string' ? body.command.trim() : '';
    if (!command) {
      writeJson(response, 422, { error: 'Either a valid command or friendly_name is required' });
      return;
    }
    const existing = state.commandsByDevice.get(deviceId) ?? [];
    const created = {
      id: `cmd-${state.nextCommandId}`,
      command,
      status: 'queued',
      created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    };
    state.nextCommandId += 1;
    existing.unshift(created);
    state.commandsByDevice.set(deviceId, existing);
    writeJson(response, 200, created);
    return;
  }

  const deviceMatch = pathname.match(/^\/core\/v1\/organization\/devices\/([^/]+)$/);
  if (deviceMatch && method === 'GET') {
    const deviceId = decodeURIComponent(deviceMatch[1]);
    const device = state.devices.get(deviceId);
    if (!device) {
      writeJson(response, 404, { error: `Unknown device ${deviceId}` });
      return;
    }
    writeJson(response, 200, device);
    return;
  }

  if (deviceMatch && method === 'PATCH') {
    const deviceId = decodeURIComponent(deviceMatch[1]);
    const device = state.devices.get(deviceId);
    if (!device) {
      writeJson(response, 404, { error: `Unknown device ${deviceId}` });
      return;
    }
    const body = await readJson(request);
    if (body && typeof body === 'object') {
      if (typeof body.name === 'string' && body.name.trim()) {
        setDeviceName(deviceId, body.name.trim());
      }
    }
    writeJson(response, 200, state.devices.get(deviceId));
    return;
  }

  const ticketMessageMatch = pathname.match(/^\/core\/v1\/organization\/tickets\/([^/]+)\/message$/);
  if (ticketMessageMatch && method === 'POST') {
    const ticketId = decodeURIComponent(ticketMessageMatch[1]);
    const ticket = state.tickets.get(ticketId);
    if (!ticket) {
      writeJson(response, 404, { error: `Unknown ticket ${ticketId}` });
      return;
    }
    const message = url.searchParams.get('message');
    if (!message || !message.trim()) {
      writeJson(response, 422, { error: 'Missing message query parameter.' });
      return;
    }
    ticket.messages.push({
      id: `msg-${ticket.messages.length + 1}`,
      message: message.trim(),
      created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    });
    ticket.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    state.tickets.set(ticket.id, ticket);
    writeJson(response, 200, { ok: true, ticket_id: ticket.id, message });
    return;
  }

  const incidentMatch = pathname.match(/^\/core\/v1\/organization\/incidents\/([^/]+)$/);
  if (incidentMatch && method === 'DELETE') {
    const incidentId = decodeURIComponent(incidentMatch[1]);
    const incident = state.incidents.get(incidentId);
    if (!incident) {
      writeJson(response, 404, { error: `Unknown incident ${incidentId}` });
      return;
    }
    incident.status = 'closed';
    incident.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    state.incidents.set(incident.id, incident);
    writeJson(response, 200, { ok: true, id: incident.id, status: incident.status });
    return;
  }

  writeJson(response, 404, { error: `Unknown route: ${method} ${pathname}` });
});

server.listen(options.port, options.host, () => {
  process.stdout.write(
    `mock_xyte_local running at http://${options.host}:${options.port} (strictAuth=${options.strictAuth})\n`
  );
});
