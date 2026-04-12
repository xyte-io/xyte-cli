import type { XyteClient } from '../types/client';
import { loadInputRows, type UtilityInputFormat } from '../utils/input-parser';
import { errorMessage } from '../utils/error-format';
import { asRecord } from '../utils/json';
import { CliUserError } from '../contracts/user-error';
import { runUtilityBatch, type UtilityBatchOperation, type UtilityBatchResult } from './utility-batch';
import { requireNonEmptyString } from './device-move-shared';

function maybeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseOptionalConfig(value: unknown, fieldName: string, rowIndex: number): Record<string, unknown> | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') {
    throw new CliUserError({ summary: `Row ${rowIndex}: field "${fieldName}" must be a JSON object or object value.` });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new CliUserError({ summary: `Row ${rowIndex}: field "${fieldName}" is not valid JSON (${errorMessage(error)}).` });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliUserError({ summary: `Row ${rowIndex}: field "${fieldName}" must parse to an object.` });
  }

  return parsed as Record<string, unknown>;
}

function parsePathSegments(value: unknown, fieldName: string, rowIndex: number): string[] {
  const fullPath = requireNonEmptyString(value, fieldName, rowIndex);
  const segments = fullPath
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new CliUserError({ summary: `Row ${rowIndex}: field "${fieldName}" must contain at least one path segment.` });
  }
  return segments;
}

function parseSpaceId(value: unknown): number | undefined {
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

function extractItemsFromSpacesResponse(data: unknown): Array<Record<string, unknown>> {
  if (!data || typeof data !== 'object') {
    return [];
  }
  const maybeItems = asRecord(data).items;
  if (!Array.isArray(maybeItems)) {
    return [];
  }
  return maybeItems.filter((item) => Boolean(item) && typeof item === 'object') as Array<Record<string, unknown>>;
}

async function listSpacesByParent(
  client: XyteClient,
  tenantId: string,
  parentId: number
): Promise<Array<Record<string, unknown>>> {
  const results: Array<Record<string, unknown>> = [];
  let page = 1;
  for (;;) {
    const response = await client.callWithMeta('organization.spaces.getSpaces', {
      tenantId,
      query: {
        parent_id: parentId,
        page,
        per_page: 100
      }
    });
    const data = response.data as unknown;
    const items = extractItemsFromSpacesResponse(data);
    results.push(...items);
    const nextPageRaw = asRecord(data).next_page;
    const nextPage = parseSpaceId(nextPageRaw);
    if (!nextPage) {
      break;
    }
    page = nextPage;
  }
  return results;
}

async function fetchRootSpaceId(client: XyteClient, tenantId: string): Promise<number> {
  const response = await client.callWithMeta('organization.spaces.getSpaces', {
    tenantId,
    query: {
      space_type: 'root',
      page: 1,
      per_page: 100
    }
  });
  const items = extractItemsFromSpacesResponse(response.data as unknown);
  const root = items.find((item) => item.parent_id === null || item.parent_id === undefined) ?? items[0];
  const rootId = root ? parseSpaceId(root.id) : undefined;
  if (rootId === undefined) {
    throw new CliUserError({ summary: 'Unable to resolve root space for import-tree.' });
  }
  return rootId;
}

export async function runSpaceImportTree(args: {
  client: XyteClient;
  tenantId: string;
  inputPath: string;
  inputFormat?: UtilityInputFormat;
  apply: boolean;
  continueOnError: boolean;
  reportPath?: string;
  pathField?: string;
  spaceTypeField?: string;
  configField?: string;
}): Promise<UtilityBatchResult> {
  const rows = loadInputRows(args.inputPath, args.inputFormat ?? 'auto').rows;
  const pathField = args.pathField ?? 'path';
  const spaceTypeField = args.spaceTypeField ?? 'space_type';
  const configField = args.configField ?? 'config';
  const resolvedSpaceCache = new Map<string, number>();
  let resolvedRootSpaceId: number | undefined;

  const ensureSpace = async (params: {
    tenantId: string;
    parentId: number;
    name: string;
    spaceType?: string;
    config?: Record<string, unknown>;
  }): Promise<number> => {
    const cacheKey = `${params.parentId}|${params.name.toLowerCase()}`;
    const cached = resolvedSpaceCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const children = await listSpacesByParent(args.client, params.tenantId, params.parentId);
    const existing = children.find((item) => {
      const name = typeof item.name === 'string' ? item.name.trim().toLowerCase() : '';
      return name === params.name.toLowerCase();
    });
    const existingId = existing ? parseSpaceId(existing.id) : undefined;
    if (existingId !== undefined) {
      resolvedSpaceCache.set(cacheKey, existingId);
      return existingId;
    }

    const body: Record<string, unknown> = {
      name: params.name,
      parent_id: params.parentId
    };
    if (params.spaceType) {
      body.space_type = params.spaceType;
    }
    if (params.config) {
      body.config = params.config;
    }

    try {
      const created = await args.client.callWithMeta('organization.spaces.findOrCreateSpace', {
        tenantId: params.tenantId,
        body
      });
      const createdId = parseSpaceId((created.data as { id?: unknown }).id);
      if (createdId === undefined) {
        throw new CliUserError({ summary: `Unable to resolve space id for "${params.name}" under parent ${params.parentId}.` });
      }
      resolvedSpaceCache.set(cacheKey, createdId);
      return createdId;
    } catch (error) {
      const retryChildren = await listSpacesByParent(args.client, params.tenantId, params.parentId);
      const retryExisting = retryChildren.find((item) => {
        const name = typeof item.name === 'string' ? item.name.trim().toLowerCase() : '';
        return name === params.name.toLowerCase();
      });
      const retryId = retryExisting ? parseSpaceId(retryExisting.id) : undefined;
      if (retryId !== undefined) {
        resolvedSpaceCache.set(cacheKey, retryId);
        return retryId;
      }
      throw error;
    }
  };

  const operations: UtilityBatchOperation[] = rows.map((row, index) => {
    const rowIndex = index + 1;
    const previewSegments =
      typeof row[pathField] === 'string'
        ? row[pathField]
            .split('/')
            .map((segment) => segment.trim())
            .filter((segment) => segment.length > 0)
        : [];
    const previewPath = previewSegments.join('/');
    const previewSpaceType = maybeString(row[spaceTypeField]);
    const previewBody: Record<string, unknown> = {
      name: previewPath
    };
    if (previewSpaceType) {
      previewBody.space_type = previewSpaceType;
    }
    if (row[configField] !== undefined && row[configField] !== null && row[configField] !== '') {
      previewBody.config = row[configField];
    }

    let prepared:
      | {
          segments: string[];
          spaceType?: string;
          config?: Record<string, unknown>;
        }
      | undefined;
    const prepare = () => {
      if (prepared) {
        return prepared;
      }
      const segments = parsePathSegments(row[pathField], pathField, rowIndex);
      const spaceType = maybeString(row[spaceTypeField]);
      const config = parseOptionalConfig(row[configField], configField, rowIndex);
      prepared = {
        segments,
        ...(spaceType ? { spaceType } : {}),
        ...(config ? { config } : {})
      };
      return prepared;
    };

    return {
      rowIndex,
      input: row,
      endpointKey: 'organization.spaces.findOrCreateSpace',
      request: {
        body: previewBody
      },
      validate: () => {
        prepare();
      },
      execute: async (_client, tenantId) => {
        const preparedRow = prepare();
        if (resolvedRootSpaceId === undefined) {
          resolvedRootSpaceId = await fetchRootSpaceId(args.client, tenantId);
        }
        let parentId = resolvedRootSpaceId;
        for (let segmentIndex = 0; segmentIndex < preparedRow.segments.length; segmentIndex += 1) {
          const segment = preparedRow.segments[segmentIndex];
          const isLeaf = segmentIndex === preparedRow.segments.length - 1;
          parentId = await ensureSpace({
            tenantId,
            parentId,
            name: segment,
            ...(isLeaf && preparedRow.spaceType ? { spaceType: preparedRow.spaceType } : {}),
            ...(isLeaf && preparedRow.config ? { config: preparedRow.config } : {})
          });
        }

        return {
          status: 200,
          durationMs: 0,
          retryCount: 0,
          data: {
            id: parentId,
            full_path: preparedRow.segments.join('/'),
            ensured: true
          },
          headers: {},
          attempts: 1
        };
      }
    };
  });

  return runUtilityBatch({
    client: args.client,
    tenantId: args.tenantId,
    command: 'space.import-tree',
    operations,
    apply: args.apply,
    continueOnError: args.continueOnError,
    reportPath: args.reportPath
  });
}
