#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_DOCS_BASES = {
  docs: 'https://docs.xyte.io',
  dev: 'https://dev.xyte.io'
};

const SPEC_PATH = resolve(process.cwd(), 'src/spec/public-endpoints.json');
const DEFAULT_MAPPING_PATH = resolve(process.cwd(), 'src/spec/external-doc-pages.json');
const DEFAULT_OVERRIDES_PATH = resolve(process.cwd(), 'src/spec/docs-gap-overrides.json');

const PATH_TOKEN_REGEX = /\{([^}]+)\}/g;

function parseArgs(argv) {
  const args = {
    strict: false,
    sync: false,
    timeoutMs: 20_000,
    mappingPath: DEFAULT_MAPPING_PATH,
    overridesPath: DEFAULT_OVERRIDES_PATH,
    specPath: SPEC_PATH
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--strict') {
      args.strict = true;
      continue;
    }
    if (arg === '--sync') {
      args.sync = true;
      continue;
    }
    if (arg === '--timeout-ms') {
      args.timeoutMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--mapping') {
      args.mappingPath = resolve(process.cwd(), argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--overrides') {
      args.overridesPath = resolve(process.cwd(), argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--spec') {
      args.specPath = resolve(process.cwd(), argv[index + 1]);
      index += 1;
      continue;
    }
  }

  return args;
}

function toSnakeCase(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function uniqueOrdered(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

export function normalizePathTemplate(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') {
    return { pathTemplate: '/', pathParams: [], rawPathParams: [] };
  }

  const rawPathParams = [];
  const pathParams = [];
  const pathTemplate = rawPath.replace(PATH_TOKEN_REGEX, (_, token) => {
    const raw = String(token);
    const normalized = toSnakeCase(raw);
    rawPathParams.push(raw);
    pathParams.push(normalized);
    return `:${normalized}`;
  });

  return {
    pathTemplate,
    pathParams,
    rawPathParams
  };
}

export function parseSsrPropsFromHtml(html) {
  const marker = '<script id="ssr-props" type="application/json">';
  const start = html.indexOf(marker);
  if (start < 0) {
    throw new Error('ssr-props script tag was not found in docs HTML');
  }
  const jsonStart = start + marker.length;
  const end = html.indexOf('</script>', jsonStart);
  if (end < 0) {
    throw new Error('ssr-props script closing tag was not found in docs HTML');
  }
  return JSON.parse(html.slice(jsonStart, end));
}

function combineBasePath(serverUrl, operationPath) {
  const op = operationPath.startsWith('/') ? operationPath : `/${operationPath}`;
  if (!serverUrl || serverUrl.includes('{')) {
    return op;
  }
  try {
    const parsed = new URL(serverUrl);
    const basePath = parsed.pathname?.replace(/\/$/, '') ?? '';
    if (!basePath || basePath === '/') {
      return op;
    }
    return `${basePath}${op}`;
  } catch {
    return op;
  }
}

function inferBase(endpointKey, serverUrl) {
  if (serverUrl?.includes('entry.xyte.io')) {
    return 'entry';
  }
  if (
    endpointKey === 'device.registration.registerDevice' ||
    endpointKey === 'device.registration.bulkRegisterDevice' ||
    endpointKey === 'device.registration.registerChildDevice'
  ) {
    return 'entry';
  }
  return 'hub';
}

function inferNamespace(key) {
  const [namespace] = key.split('.');
  if (namespace !== 'device' && namespace !== 'organization' && namespace !== 'partner') {
    throw new Error(`Unsupported endpoint namespace in key: ${key}`);
  }
  return namespace;
}

function inferGroupAndAction(key) {
  const parts = key.split('.');
  if (parts.length < 2) {
    throw new Error(`Invalid endpoint key format: ${key}`);
  }
  if (parts.length === 2) {
    return { group: 'general', action: parts[1] };
  }
  return {
    group: parts[1],
    action: parts.slice(2).join('.')
  };
}

function inferAuthScope(key) {
  const namespace = inferNamespace(key);
  if (namespace === 'organization') {
    return 'organization';
  }
  if (namespace === 'partner') {
    return 'partner';
  }
  return 'device';
}

function extractBodyExample(operation) {
  const requestBody = operation?.requestBody;
  if (!requestBody || typeof requestBody !== 'object') {
    return undefined;
  }

  const content = requestBody.content ?? {};
  const preferred = content['application/json'] ?? Object.values(content)[0];
  if (!preferred || typeof preferred !== 'object') {
    return undefined;
  }

  const examples = preferred.examples;
  if (examples && typeof examples === 'object') {
    const first = Object.values(examples)[0];
    if (first && typeof first === 'object' && 'value' in first) {
      const value = first.value;
      return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    }
  }

  if (preferred.example !== undefined) {
    return typeof preferred.example === 'string' ? preferred.example : JSON.stringify(preferred.example, null, 2);
  }

  return undefined;
}

function inferBodyType(operation) {
  const requestBody = operation?.requestBody;
  if (!requestBody || typeof requestBody !== 'object') {
    return { bodyType: 'none', hasBody: false };
  }

  const content = requestBody.content ?? {};
  if (Object.keys(content).some((contentType) => contentType.includes('multipart/form-data'))) {
    return { bodyType: 'multipart-form', hasBody: true };
  }
  if (Object.keys(content).length > 0) {
    return { bodyType: 'json', hasBody: true };
  }
  return { bodyType: 'unknown', hasBody: true };
}

function normalizeQueryParams(operation) {
  const parameters = Array.isArray(operation?.parameters) ? operation.parameters : [];
  const queryParams = parameters
    .filter((parameter) => parameter?.in === 'query' && typeof parameter?.name === 'string')
    .map((parameter) => toSnakeCase(parameter.name));
  return uniqueOrdered(queryParams);
}

function applyOverride(spec, override) {
  if (!override || typeof override !== 'object') {
    return spec;
  }

  const next = { ...spec };
  if (typeof override.authScope === 'string') {
    next.authScope = override.authScope;
  }
  if (typeof override.base === 'string') {
    next.base = override.base;
  }
  if (Array.isArray(override.queryParams)) {
    next.queryParams = override.queryParams.map((value) => String(value));
  }
  if (typeof override.pathTemplate === 'string') {
    next.pathTemplate = override.pathTemplate;
    next.pathParams = uniqueOrdered(Array.from(override.pathTemplate.matchAll(/:([a-zA-Z0-9_]+)/g), (match) => match[1]));
  }
  if (typeof override.bodyType === 'string') {
    next.bodyType = override.bodyType;
  }
  if (typeof override.hasBody === 'boolean') {
    next.hasBody = override.hasBody;
  }
  if (Array.isArray(override.notes)) {
    next.notes = [...(next.notes ?? []), ...override.notes.map((value) => String(value))];
  }

  return next;
}

export function buildEndpointSpecFromDocPage({ key, docsUrl, props, override }) {
  const namespace = inferNamespace(key);
  const { group, action } = inferGroupAndAction(key);

  const api = props?.document?.api;
  const schema = api?.schema;
  const operationPath = api?.path;
  const method = String(api?.method ?? '').toUpperCase();

  if (!schema || !schema.paths || !operationPath || !method) {
    throw new Error(`Missing API schema/path/method in docs payload for ${key} (${docsUrl})`);
  }

  const operation = schema.paths?.[operationPath]?.[method.toLowerCase()];
  if (!operation) {
    throw new Error(`Operation not found for ${key}: ${method} ${operationPath} (${docsUrl})`);
  }

  const serverUrl = schema.servers?.[0]?.url ?? '';
  const combinedPath = combineBasePath(serverUrl, operationPath);
  const normalizedPath = normalizePathTemplate(combinedPath);
  const body = inferBodyType(operation);
  const queryParams = normalizeQueryParams(operation);

  const notes = [
    `Docs page: ${docsUrl}`,
    `Docs category: ${props?.document?.category?.uri ?? 'n/a'}`,
    `Docs parent: ${props?.document?.parent?.uri ?? 'n/a'}`
  ];
  if (normalizedPath.rawPathParams.length > 0) {
    notes.push(`Docs raw path params: ${normalizedPath.rawPathParams.join(', ')}`);
  }

  const spec = {
    key,
    namespace,
    group,
    action,
    title: String(props?.document?.title ?? operation?.summary ?? key),
    method,
    base: inferBase(key, serverUrl),
    pathTemplate: normalizedPath.pathTemplate,
    pathParams: normalizedPath.pathParams,
    queryParams,
    authScope: inferAuthScope(key),
    bodyType: body.bodyType,
    hasBody: body.hasBody,
    sourceFile: docsUrl,
    bodyExample: extractBodyExample(operation),
    notes
  };

  return applyOverride(spec, override);
}

function loadJson(path, fallback = undefined) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (fallback !== undefined) {
      return fallback;
    }
    throw error;
  }
}

async function fetchPage(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function generateContracts({ mappingPath = DEFAULT_MAPPING_PATH, overridesPath = DEFAULT_OVERRIDES_PATH, timeoutMs = 20_000 } = {}) {
  const mapping = loadJson(mappingPath);
  const overrides = loadJson(overridesPath, {});

  const sources = {
    ...DEFAULT_DOCS_BASES,
    ...(mapping.sources ?? {})
  };

  const entries = Object.entries(mapping.pages ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const contracts = [];

  for (const [key, pageSpec] of entries) {
    const baseUrl = sources[pageSpec.source];
    if (!baseUrl) {
      throw new Error(`Missing source base URL for ${pageSpec.source} (${key})`);
    }

    const docsUrl = `${baseUrl}${pageSpec.path}`;
    const html = await fetchPage(docsUrl, timeoutMs);
    const props = parseSsrPropsFromHtml(html);
    if (props?.code === 404) {
      throw new Error(`Docs page returned 404: ${docsUrl} (${key})`);
    }

    contracts.push(
      buildEndpointSpecFromDocPage({
        key,
        docsUrl,
        props,
        override: overrides[key]
      })
    );
  }

  return contracts;
}

function normalizeRows(rows) {
  return new Map(rows.map((row) => [row.key, row]));
}

export function compareContracts(localRows, docsRows) {
  const local = normalizeRows(localRows);
  const docs = normalizeRows(docsRows);

  const localKeys = new Set(local.keys());
  const docsKeys = new Set(docs.keys());

  const missingInLocal = [];
  const missingInDocs = [];
  const mismatches = [];

  for (const key of docsKeys) {
    if (!localKeys.has(key)) {
      missingInLocal.push(key);
      continue;
    }

    const left = local.get(key);
    const right = docs.get(key);
    const fields = ['method', 'pathTemplate', 'base', 'authScope', 'bodyType', 'hasBody'];
    const diff = {};

    for (const field of fields) {
      if (JSON.stringify(left[field]) !== JSON.stringify(right[field])) {
        diff[field] = { local: left[field], docs: right[field] };
      }
    }

    if (JSON.stringify(left.queryParams ?? []) !== JSON.stringify(right.queryParams ?? [])) {
      diff.queryParams = {
        local: left.queryParams ?? [],
        docs: right.queryParams ?? []
      };
    }

    if (JSON.stringify(left.pathParams ?? []) !== JSON.stringify(right.pathParams ?? [])) {
      diff.pathParams = {
        local: left.pathParams ?? [],
        docs: right.pathParams ?? []
      };
    }

    if (Object.keys(diff).length > 0) {
      mismatches.push({ key, diff });
    }
  }

  for (const key of localKeys) {
    if (!docsKeys.has(key)) {
      missingInDocs.push(key);
    }
  }

  return {
    missingInLocal: missingInLocal.sort(),
    missingInDocs: missingInDocs.sort(),
    mismatches: mismatches.sort((a, b) => a.key.localeCompare(b.key))
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const docsRows = await generateContracts({
    mappingPath: args.mappingPath,
    overridesPath: args.overridesPath,
    timeoutMs: args.timeoutMs
  });

  if (args.sync) {
    writeFileSync(args.specPath, `${JSON.stringify(docsRows, null, 2)}\n`);
  }

  const localRows = loadJson(args.specPath);
  const comparison = compareContracts(localRows, docsRows);

  const hasDrift =
    comparison.missingInLocal.length > 0 ||
    comparison.missingInDocs.length > 0 ||
    comparison.mismatches.length > 0;

  const report = {
    checkedAt: new Date().toISOString(),
    docs: {
      mappingPath: args.mappingPath,
      overridesPath: args.overridesPath,
      endpointCount: docsRows.length
    },
    local: {
      specPath: args.specPath,
      endpointCount: localRows.length
    },
    sync: args.sync,
    status: hasDrift ? 'drift' : 'ok',
    missingInLocalCount: comparison.missingInLocal.length,
    missingInDocsCount: comparison.missingInDocs.length,
    mismatchCount: comparison.mismatches.length,
    missingInLocal: comparison.missingInLocal,
    missingInDocs: comparison.missingInDocs,
    mismatches: comparison.mismatches
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (args.strict && hasDrift) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
