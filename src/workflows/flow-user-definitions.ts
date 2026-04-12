import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { CliUserError } from '../contracts/user-error';
import { getXyteConfigDir } from '../utils/config-dir';
import { errorMessage } from '../utils/error-format';
import { getLogger } from '../observability/logger';
import { FLOW_DEFINITION_SCHEMA_VERSION } from '../contracts/versions';

const FLOW_ID_RE = /^flow\.[a-z0-9][a-z0-9._-]*$/;

const FlowDefinitionV1Schema = z
  .object({
    schemaVersion: z.string().refine((v) => v === FLOW_DEFINITION_SCHEMA_VERSION, { message: `Flow definition schemaVersion must be ${FLOW_DEFINITION_SCHEMA_VERSION}.` }),
    id: z.string().transform((v, ctx) => {
      const normalized = v.trim();
      if (!FLOW_ID_RE.test(normalized)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid flow id: ${v}. Use flow.<name> with lowercase letters, numbers, dots, underscores, or dashes.` });
        return z.NEVER;
      }
      return normalized;
    }),
    title: z.string().optional(),
    description: z.string().trim().optional(),
    basedOn: z.string().transform((v, ctx) => {
      const trimmed = v.trim();
      if (!trimmed) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Flow definition requires basedOn.' });
        return z.NEVER;
      }
      return trimmed;
    }),
    defaults: z.record(z.string(), z.string()).default({}),
    createdAtUtc: z.string().optional().transform((v) => (v?.trim() || new Date().toISOString())),
    updatedAtUtc: z.string().optional().transform((v) => (v?.trim() || new Date().toISOString()))
  })
  .transform((v) => ({
    ...v,
    title: v.title?.trim() || v.id
  }));

type FlowDefinitionV1 = z.infer<typeof FlowDefinitionV1Schema>;

function isFlowId(value: string): boolean {
  return FLOW_ID_RE.test(value);
}

function normalizeFlowId(value: string): string {
  const normalized = value.trim();
  if (!isFlowId(normalized)) {
    throw new CliUserError({
      summary: `Invalid flow id: ${value}.`,
      detail: 'Use flow.<name> with lowercase letters, numbers, dots, underscores, or dashes.'
    });
  }
  return normalized;
}

function validateFlowDefinition(value: unknown): FlowDefinitionV1 {
  const result = FlowDefinitionV1Schema.safeParse(value);
  if (!result.success) {
    throw new CliUserError({ summary: result.error.issues.map((e: z.ZodIssue) => e.message).join('; ') });
  }
  return result.data;
}

function getFlowDefinitionsDir(): string {
  return path.join(getXyteConfigDir(), 'flows');
}

function getFlowDefinitionPath(flowId: string): string {
  const id = normalizeFlowId(flowId);
  return path.join(getFlowDefinitionsDir(), `${id}.json`);
}

export async function listFlowDefinitions(): Promise<{
  defs: Array<FlowDefinitionV1 & { path: string }>;
  skipped: Array<{ path: string; reason: string }>;
}> {
  const root = getFlowDefinitionsDir();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { defs: [], skipped: [] };
    throw error;
  }
  const defs: Array<FlowDefinitionV1 & { path: string }> = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    const filePath = path.join(root, entry.name);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
      if (error instanceof SyntaxError) {
        skipped.push({ path: filePath, reason: errorMessage(error) });
        continue;
      }
      throw error; // I/O error, propagate
    }
    try {
      const parsed = validateFlowDefinition(raw);
      defs.push({ ...parsed, path: filePath });
    } catch (error) {
      skipped.push({ path: filePath, reason: errorMessage(error) });
    }
  }

  return { defs: defs.sort((left, right) => left.id.localeCompare(right.id)), skipped };
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
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
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
    throw new CliUserError({
      summary: `Flow ${id} already exists.`,
      suggestedCommands: ['Re-run with --force to overwrite', 'xyte-cli flow edit to update it']
    });
  }

  const now = new Date().toISOString();
  const payload: FlowDefinitionV1 = {
    schemaVersion: FLOW_DEFINITION_SCHEMA_VERSION,
    id,
    title: args.title?.trim() || existing?.title || id,
    ...(args.description?.trim()
      ? { description: args.description.trim() }
      : existing?.description
        ? { description: existing.description }
        : {}),
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
    throw new CliUserError({
      summary: `Unknown flow definition: ${args.flowId}.`,
      suggestedCommands: ['xyte-cli flow create to create it first']
    });
  }

  const now = new Date().toISOString();
  const mergedDefaults = args.replaceDefaults
    ? (args.defaults ?? {})
    : {
        ...existing.defaults,
        ...(args.defaults ?? {})
      };

  const next: FlowDefinitionV1 = {
    schemaVersion: FLOW_DEFINITION_SCHEMA_VERSION,
    id: existing.id,
    title: args.title?.trim() || existing.title,
    ...(args.description?.trim()
      ? { description: args.description.trim() }
      : existing.description
        ? { description: existing.description }
        : {}),
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

export async function exportFlowDefinition(args: {
  flowId: string;
  outPath: string;
}): Promise<{ flow: FlowDefinitionV1; outPath: string }> {
  const { flowId, outPath } = args;
  const existing = await getFlowDefinition(flowId);
  if (!existing) {
    throw new CliUserError({ summary: `Unknown flow definition: ${flowId}.` });
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

export async function importFlowDefinition(args: {
  filePath: string;
  force: boolean;
}): Promise<FlowDefinitionV1 & { path: string; status: 'created' | 'updated' }> {
  const resolved = path.resolve(args.filePath);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolved, 'utf8'));
  } catch (error) {
    const isSyntax = error instanceof SyntaxError;
    const detail = isSyntax ? `: ${error.message}` : `: ${errorMessage(error)}`;
    throw new CliUserError({ summary: `Failed to ${isSyntax ? 'parse' : 'read'} flow definition at "${resolved}"${detail}` });
  }
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
