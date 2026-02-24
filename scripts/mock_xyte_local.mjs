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

function makeInitialState() {
  return {
    devices: new Map([
      ['d1', { id: 'd1', name: 'Device One', space_id: 'default' }],
      ['d2', { id: 'd2', name: 'Device Two', space_id: 'default' }]
    ]),
    spacesByPath: new Map([
      ['default', { id: 'default', name: 'Default', full_path: 'default', space_type: 'site', config: {} }]
    ]),
    nextSpaceId: 1
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

function listSpaces() {
  return Array.from(state.spacesByPath.values());
}

function makeSpaceFromPath(fullPath, body) {
  const existing = state.spacesByPath.get(fullPath);
  if (existing) {
    return { ...existing, found: true };
  }

  const pathParts = String(fullPath)
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  const name = pathParts[pathParts.length - 1] ?? fullPath;

  const created = {
    id: `sp-${state.nextSpaceId}`,
    name,
    full_path: fullPath,
    space_type: typeof body.space_type === 'string' ? body.space_type : 'space',
    config: body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {}
  };
  state.nextSpaceId += 1;
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
      devices: Array.from(state.devices.values()),
      spaces: listSpaces()
    });
    return;
  }

  if (!authGuard(request, response)) {
    return;
  }

  if (pathname === '/core/v1/organization/devices' && method === 'GET') {
    writeJson(response, 200, { items: Array.from(state.devices.values()) });
    return;
  }

  if (pathname === '/core/v1/organization/spaces' && method === 'GET') {
    writeJson(response, 200, { items: listSpaces() });
    return;
  }

  if (pathname === '/core/v1/organization/spaces/find_or_create' && method === 'POST') {
    const body = await readJson(request);
    if (!body || typeof body !== 'object' || typeof body.name !== 'string' || !body.name.trim()) {
      writeJson(response, 400, { error: 'Body must include non-empty "name".' });
      return;
    }
    const created = makeSpaceFromPath(body.name.trim(), body);
    writeJson(response, 200, created);
    return;
  }

  const deviceMatch = pathname.match(/^\/core\/v1\/organization\/devices\/([^/]+)$/);
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
        device.name = body.name.trim();
      }
    }
    state.devices.set(deviceId, device);
    writeJson(response, 200, device);
    return;
  }

  writeJson(response, 404, { error: `Unknown route: ${method} ${pathname}` });
});

server.listen(options.port, options.host, () => {
  process.stdout.write(
    `mock_xyte_local running at http://${options.host}:${options.port} (strictAuth=${options.strictAuth})\n`
  );
});
