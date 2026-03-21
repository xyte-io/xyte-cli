import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { getXyteConfigDir } from '../utils/config-dir';

const FLOW_DEFINITION_SCHEMA_VERSION = 'xyte.flow.definition.v1';

interface FlowDefinitionV1 {
  schemaVersion: typeof FLOW_DEFINITION_SCHEMA_VERSION;
  id: string;
  title: string;
  description?: string;
  basedOn: string;
  defaults: Record<string, string>;
  createdAtUtc: string;
  updatedAtUtc: string;
}

function isFlowId(value: string): boolean {
  return /^flow\.[a-z0-9][a-z0-9._-]*$/.test(value);
}

function normalizeFlowId(value: string): string {
  const normalized = value.trim();
  if (!isFlowId(normalized)) {
    throw new Error(`Invalid flow id: ${value}. Use flow.<name> with lowercase letters, numbers, dots, underscores, or dashes.`);
  }
  return normalized;
}

function validateFlowDefinition(value: unknown): FlowDefinitionV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Flow definition must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== FLOW_DEFINITION_SCHEMA_VERSION) {
    throw new Error(`Flow definition schemaVersion must be ${FLOW_DEFINITION_SCHEMA_VERSION}.`);
  }
  const id = typeof record.id === 'string' ? normalizeFlowId(record.id) : '';
  if (!id) {
    throw new Error('Flow definition requires id.');
  }
  const basedOn = typeof record.basedOn === 'string' ? record.basedOn.trim() : '';
  if (!basedOn) {
    throw new Error('Flow definition requires basedOn.');
  }
  const title = typeof record.title === 'string' && record.title.trim() ? record.title.trim() : id;
  const description = typeof record.description === 'string' && record.description.trim() ? record.description.trim() : undefined;

  const defaultsRaw = record.defaults;
  const defaults: Record<string, string> = {};
  if (defaultsRaw !== undefined) {
    if (!defaultsRaw || typeof defaultsRaw !== 'object' || Array.isArray(defaultsRaw)) {
      throw new Error('Flow definition defaults must be an object of string values.');
    }
    for (const [key, item] of Object.entries(defaultsRaw as Record<string, unknown>)) {
      if (typeof item !== 'string') {
        throw new Error(`Flow definition default \"${key}\" must be a string.`);
      }
      defaults[key] = item;
    }
  }

  const createdAtUtc = typeof record.createdAtUtc === 'string' && record.createdAtUtc.trim() ? record.createdAtUtc : new Date().toISOString();
  const updatedAtUtc = typeof record.updatedAtUtc === 'string' && record.updatedAtUtc.trim() ? record.updatedAtUtc : new Date().toISOString();

  return {
    schemaVersion: FLOW_DEFINITION_SCHEMA_VERSION,
    id,
    title,
    ...(description ? { description } : {}),
    basedOn,
    defaults,
    createdAtUtc,
    updatedAtUtc
  };
}

function getFlowDefinitionsDir(): string {
  return path.join(getXyteConfigDir(), 'flows');
}

function getFlowDefinitionPath(flowId: string): string {
  const id = normalizeFlowId(flowId);
  return path.join(getFlowDefinitionsDir(), `${id}.json`);
}

export async function listFlowDefinitions(): Promise<Array<FlowDefinitionV1 & { path: string }>> {
  const root = getFlowDefinitionsDir();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const defs: Array<FlowDefinitionV1 & { path: string }> = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    const filePath = path.join(root, entry.name);
    try {
      const raw = JSON.parse(await readFile(filePath, 'utf8'));
      const parsed = validateFlowDefinition(raw);
      defs.push({
        ...parsed,
        path: filePath
      });
    } catch {
      // Keep listing resilient to invalid files; they can be fixed manually.
    }
  }

  return defs.sort((left, right) => left.id.localeCompare(right.id));
}

export async function getFlowDefinition(flowId: string): Promise<(FlowDefinitionV1 & { path: string }) | undefined> {
  const filePath = getFlowDefinitionPath(flowId);
  try {
    const raw = JSON.parse(await readFile(filePath, 'utf8'));
    return {
      ...validateFlowDefinition(raw),
      path: filePath
    };
  } catch (error) {
    if (error instanceof Error && /ENOENT/.test(error.message)) {
      return undefined;
    }
    throw error;
  }
}

export async function saveFlowDefinition(args: {
  flowId: string;
  basedOn: string;
  title?: string;
  description?: string;
  defaults?: Record<string, string>;
  overwrite: boolean;
}): Promise<FlowDefinitionV1 & { path: string; status: 'created' | 'updated' }> {
  const id = normalizeFlowId(args.flowId);
  const existing = await getFlowDefinition(id);
  if (existing && !args.overwrite) {
    throw new Error(`Flow ${id} already exists. Re-run with --force or use flow edit.`);
  }

  const now = new Date().toISOString();
  const payload: FlowDefinitionV1 = {
    schemaVersion: FLOW_DEFINITION_SCHEMA_VERSION,
    id,
    title: args.title?.trim() || existing?.title || id,
    ...(args.description?.trim() ? { description: args.description.trim() } : existing?.description ? { description: existing.description } : {}),
    basedOn: args.basedOn.trim(),
    defaults: args.defaults ?? existing?.defaults ?? {},
    createdAtUtc: existing?.createdAtUtc ?? now,
    updatedAtUtc: now
  };

  const filePath = getFlowDefinitionPath(id);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  return {
    ...payload,
    path: filePath,
    status: existing ? 'updated' : 'created'
  };
}

export async function updateFlowDefinition(args: {
  flowId: string;
  basedOn?: string;
  title?: string;
  description?: string;
  defaults?: Record<string, string>;
  replaceDefaults?: boolean;
}): Promise<FlowDefinitionV1 & { path: string }> {
  const existing = await getFlowDefinition(args.flowId);
  if (!existing) {
    throw new Error(`Unknown flow definition: ${args.flowId}. Use flow create first.`);
  }

  const now = new Date().toISOString();
  const mergedDefaults = args.replaceDefaults
    ? args.defaults ?? {}
    : {
        ...existing.defaults,
        ...(args.defaults ?? {})
      };

  const next: FlowDefinitionV1 = {
    schemaVersion: FLOW_DEFINITION_SCHEMA_VERSION,
    id: existing.id,
    title: args.title?.trim() || existing.title,
    ...(args.description?.trim() ? { description: args.description.trim() } : existing.description ? { description: existing.description } : {}),
    basedOn: args.basedOn?.trim() || existing.basedOn,
    defaults: mergedDefaults,
    createdAtUtc: existing.createdAtUtc,
    updatedAtUtc: now
  };

  await writeFile(existing.path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return {
    ...next,
    path: existing.path
  };
}

export async function exportFlowDefinition(args: { flowId: string; outPath: string }): Promise<{ flow: FlowDefinitionV1; outPath: string }> {
  const { flowId, outPath } = args;
  const existing = await getFlowDefinition(flowId);
  if (!existing) {
    throw new Error(`Unknown flow definition: ${flowId}.`);
  }

  const resolvedOut = path.resolve(outPath);
  await mkdir(path.dirname(resolvedOut), { recursive: true });
  const payload: FlowDefinitionV1 = {
    schemaVersion: existing.schemaVersion,
    id: existing.id,
    title: existing.title,
    ...(existing.description ? { description: existing.description } : {}),
    basedOn: existing.basedOn,
    defaults: existing.defaults,
    createdAtUtc: existing.createdAtUtc,
    updatedAtUtc: existing.updatedAtUtc
  };
  await writeFile(resolvedOut, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return {
    flow: payload,
    outPath: resolvedOut
  };
}

export async function importFlowDefinition(args: { filePath: string; force: boolean }): Promise<FlowDefinitionV1 & { path: string; status: 'created' | 'updated' }> {
  const resolved = path.resolve(args.filePath);
  const raw = JSON.parse(await readFile(resolved, 'utf8'));
  const parsed = validateFlowDefinition(raw);

  return saveFlowDefinition({
    flowId: parsed.id,
    basedOn: parsed.basedOn,
    title: parsed.title,
    description: parsed.description,
    defaults: parsed.defaults,
    overwrite: args.force
  });
}
