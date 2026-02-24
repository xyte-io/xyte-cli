import type { XyteClient } from '../types/client';
import { loadInputRows, type UtilityInputFormat } from '../utils/input-parser';
import { runUtilityBatch, type UtilityBatchOperation, type UtilityBatchResult } from './utility-batch';

function requireNonEmptyString(value: unknown, fieldName: string, rowIndex: number): string {
  if (typeof value !== 'string') {
    throw new Error(`Row ${rowIndex}: field "${fieldName}" must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Row ${rowIndex}: field "${fieldName}" cannot be empty.`);
  }
  return trimmed;
}

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
    throw new Error(`Row ${rowIndex}: field "${fieldName}" must be a JSON object or object value.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Row ${rowIndex}: field "${fieldName}" is not valid JSON (${detail}).`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Row ${rowIndex}: field "${fieldName}" must parse to an object.`);
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
    throw new Error(`Row ${rowIndex}: field "${fieldName}" must contain at least one path segment.`);
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
  const maybeItems = (data as { items?: unknown }).items;
  if (!Array.isArray(maybeItems)) {
    return [];
  }
  return maybeItems.filter((item) => Boolean(item) && typeof item === 'object') as Array<Record<string, unknown>>;
}

async function listSpacesByParent(client: XyteClient, tenantId: string, parentId: number): Promise<Array<Record<string, unknown>>> {
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
    const nextPageRaw = data && typeof data === 'object' ? (data as { next_page?: unknown }).next_page : undefined;
    const nextPage = parseSpaceId(nextPageRaw);
    if (!nextPage) {
      break;
    }
    page = nextPage;
  }
  return results;
}

export async function runDeviceBulkRename(args: {
  client: XyteClient;
  tenantId: string;
  inputPath: string;
  inputFormat?: UtilityInputFormat;
  apply: boolean;
  continueOnError: boolean;
  reportPath?: string;
  deviceIdField?: string;
  newNameField?: string;
  renameBodyField?: string;
}): Promise<UtilityBatchResult> {
  const rows = loadInputRows(args.inputPath, args.inputFormat ?? 'auto').rows;
  const deviceIdField = args.deviceIdField ?? 'device_id';
  const newNameField = args.newNameField ?? 'new_name';
  const renameBodyField = args.renameBodyField ?? 'name';

  const operations: UtilityBatchOperation[] = rows.map((row, index) => {
    const rowIndex = index + 1;
    const previewDeviceId = typeof row[deviceIdField] === 'string' ? row[deviceIdField].trim() : '';
    const previewNewName = typeof row[newNameField] === 'string' ? row[newNameField].trim() : row[newNameField];

    let prepared: { deviceId: string; body: Record<string, unknown> } | undefined;
    const prepare = () => {
      if (prepared) {
        return prepared;
      }
      const deviceId = requireNonEmptyString(row[deviceIdField], deviceIdField, rowIndex);
      const newName = requireNonEmptyString(row[newNameField], newNameField, rowIndex);
      prepared = {
        deviceId,
        body: {
          [renameBodyField]: newName
        }
      };
      return prepared;
    };

    return {
      rowIndex,
      input: row,
      endpointKey: 'organization.devices.updateDevice',
      request: {
        path: { device_id: previewDeviceId },
        body: {
          [renameBodyField]: previewNewName
        }
      },
      validate: () => {
        prepare();
      },
      execute: (client, tenantId) =>
        client.callWithMeta('organization.devices.updateDevice', {
          tenantId,
          path: { device_id: prepare().deviceId },
          body: prepare().body
        })
    };
  });

  return runUtilityBatch({
    client: args.client,
    tenantId: args.tenantId,
    command: 'device.bulk-rename',
    operations,
    apply: args.apply,
    continueOnError: args.continueOnError,
    reportPath: args.reportPath
  });
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
  const rootParentId = 1;
  const resolvedSpaceCache = new Map<string, number>();

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
        throw new Error(`Unable to resolve space id for "${params.name}" under parent ${params.parentId}.`);
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
        let parentId = rootParentId;
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
