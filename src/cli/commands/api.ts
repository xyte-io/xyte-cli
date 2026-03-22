import { randomUUID } from 'node:crypto';

import type { Command } from 'commander';

import { getEndpoint, listEndpoints } from '../../client/catalog';
import { buildCallEnvelope } from '../../contracts/call-envelope';
import { toProblemDetails } from '../../contracts/problem';
import { CliUserError } from '../../contracts/user-error';
import { isMutatingMethod } from '../../http/http';
import { parseJsonObject } from '../../utils/json';
import { parseQueryJson } from '../parse-options';
import {
  type CliContext,
  type CliGlobalOptions,
  printJson,
  resolveStrictJson,
  resolveTextJsonOutput
} from '../cli-context';

function parsePathJson(value: string | undefined): Record<string, string | number> {
  const record = parseJsonObject(value);
  const out: Record<string, string | number> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string' || typeof item === 'number') {
      out[key] = item;
      continue;
    }
    throw new Error(`Path parameter "${key}" must be string or number.`);
  }
  return out;
}

async function handleApiEndpointsList(ctx: CliContext, options: { tenant?: string; output?: string; format?: string }): Promise<void> {
  const settings = await ctx.resolveSettings(options.tenant ? { 'defaults.tenant': options.tenant } : {});
  const tenantId = options.tenant ?? settings.values.defaults.tenant;
  const payload = tenantId ? await (await ctx.withClient({ tenantId })).listTenantEndpoints(tenantId) : listEndpoints();
  const output = resolveTextJsonOutput({
    output: options.output,
    format: options.format,
    stdoutIsTTY: ctx.stdoutIsTTY,
    settings
  });
  if (output === 'text') {
    const rows = Array.isArray(payload) ? payload.map((item) => item.key) : [];
    ctx.stdout.write(rows.join('\n') + (rows.length ? '\n' : ''));
    return;
  }
  printJson(ctx.stdout, payload, { strictJson: resolveStrictJson({ settings }) });
}

async function handleApiEndpointsDescribe(ctx: CliContext, key: string, options: { output?: string; format?: string } = {}): Promise<void> {
  const settings = await ctx.resolveSettings();
  const endpoint = getEndpoint(key);
  const output = resolveTextJsonOutput({
    output: options.output,
    format: options.format,
    stdoutIsTTY: ctx.stdoutIsTTY,
    settings
  });
  if (output === 'text') {
    ctx.stdout.write(`${endpoint.key}\n${endpoint.method} ${endpoint.pathTemplate}\nauth=${endpoint.authScope}\n`);
    return;
  }
  printJson(ctx.stdout, endpoint, { strictJson: resolveStrictJson({ settings }) });
}

interface ApiCallOptions {
  tenant?: string;
  pathJson?: string;
  queryJson?: string;
  bodyJson?: string;
  outputMode?: string;
  output?: string;
  strictJson?: boolean;
}

async function handleApiCall(ctx: CliContext, key: string, options: ApiCallOptions): Promise<void> {
  const tenantOverride = options.tenant;
  const settings = await ctx.resolveSettings(tenantOverride ? { 'defaults.tenant': tenantOverride } : {});
  const endpoint = getEndpoint(key);
  const method = endpoint.method.toUpperCase();
  const outputMode = String(options.outputMode ?? 'raw').trim().toLowerCase();
  if (!['raw', 'envelope'].includes(outputMode)) {
    throw new CliUserError({
      summary: 'Invalid API call output mode.',
      cause: `Received "${outputMode}".`,
      suggestedCommands: ['Use --output-mode raw', 'Use --output-mode envelope']
    });
  }
  const requestId = randomUUID();
  const tenantId = tenantOverride ?? settings.values.defaults.tenant;
  const path = parsePathJson(options.pathJson);
  const query = parseQueryJson(options.queryJson);
  let body: unknown;
  if (options.bodyJson) {
    try {
      body = JSON.parse(String(options.bodyJson));
    } catch (error) {
      const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
      throw new Error(`Invalid --body-json${detail}`);
    }
  }
  const strictJson = resolveStrictJson({ strictJson: options.strictJson, settings });
  const mutating = isMutatingMethod(method);

  const envelopeBase = {
    requestId,
    tenantId,
    endpointKey: key,
    method,
    guard: { allowWrite: mutating },
    request: { path, query, body }
  };

  try {
    const client = await ctx.withClient({ tenantId });
    const result = await client.callWithMeta(key, {
      requestId,
      tenantId,
      path,
      query,
      body
    });

    if (outputMode === 'envelope') {
      const envelope = buildCallEnvelope({
        ...envelopeBase,
        response: {
          status: result.status,
          durationMs: result.durationMs,
          retryCount: result.retryCount,
          data: result.data
        }
      });
      printJson(ctx.stdout, envelope, { strictJson });
      return;
    }

    const output = resolveTextJsonOutput({
      output: options.output,
      stdoutIsTTY: ctx.stdoutIsTTY,
      settings
    });
    if (output === 'text') {
      ctx.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
      return;
    }
    printJson(ctx.stdout, result.data, { strictJson });
  } catch (error) {
    if (outputMode !== 'envelope') {
      throw error;
    }

    const envelope = buildCallEnvelope({
      ...envelopeBase,
      error: toProblemDetails(error, `/api/call/${key}`)
    });
    printJson(ctx.stdout, envelope, { strictJson });
    process.exitCode = 1;
  }
}

export function registerApiCommands(parent: Command, ctx: CliContext): void {
  const api = parent.command('api').description('Raw endpoint catalog and invocation');
  api.addHelpText(
    'after',
    [
      '',
      'Examples:',
      '  xyte-cli api endpoints list --tenant <tenant-id>',
      '  xyte-cli api endpoints describe organization.devices.getDevices',
      '  xyte-cli api call organization.devices.getDevices --tenant <tenant-id> --output json'
    ].join('\n')
  );
  const apiEndpoints = api.command('endpoints').description('List and describe endpoint metadata');

  apiEndpoints
    .command('list')
    .option('--tenant <tenantId>', 'Filter endpoints available for tenant credentials')
    .option('--format <format>', 'json|text')
    .action(async function (options: { tenant?: string; format?: string }) {
      await handleApiEndpointsList(ctx, {
        ...options,
        output: (this.optsWithGlobals() as CliGlobalOptions).output
      });
    });

  apiEndpoints
    .command('describe')
    .argument('<key>', 'Endpoint key')
    .option('--format <format>', 'json|text')
    .action(async function (key: string, options: { format?: string }) {
      await handleApiEndpointsDescribe(ctx, key, {
        ...options,
        output: (this.optsWithGlobals() as CliGlobalOptions).output
      });
    });

  api
    .command('call')
    .argument('<key>', 'Endpoint key')
    .description('Call endpoint by key')
    .option('--tenant <tenantId>', 'Tenant id')
    .option('--path-json <json>', 'Path params JSON object')
    .option('--query-json <json>', 'Query params JSON object')
    .option('--body-json <json>', 'Body JSON object')
    .option('--output-mode <mode>', 'raw|envelope', 'raw')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(async function (key: string, options: ApiCallOptions) {
      await handleApiCall(ctx, key, {
        ...options,
        output: (this.optsWithGlobals() as CliGlobalOptions).output
      });
    });
}
