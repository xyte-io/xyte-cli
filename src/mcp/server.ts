import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020';

import { createXyteClient } from '../client/create-client';
import { getEndpoint, listEndpoints } from '../client/catalog';
import { buildCallEnvelope } from '../contracts/call-envelope';
import { toProblemDetails } from '../contracts/problem';
import { evaluateReadiness } from '../config/readiness';
import type { KeychainStore } from '../secure/keychain';
import type { ProfileStore } from '../secure/profile-store';
import { buildFleetInspect, collectFleetSnapshot, generateFleetReport } from '../workflows/fleet-insights';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerOptions {
  profileStore: ProfileStore;
  keychain: KeychainStore;
  input?: NodeJS.ReadableStream;
  output?: Pick<typeof process.stdout, 'write'>;
}

function rpcError(id: JsonRpcResponse['id'], code: number, message: string, data?: unknown): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      data
    }
  };
}

function writeJson(output: Pick<typeof process.stdout, 'write'>, value: JsonRpcResponse): void {
  output.write(`${JSON.stringify(value)}\n`);
}

function hasProperty(value: unknown, key: string): boolean {
  return Boolean(value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key));
}

function parseString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Expected non-empty string for "${field}"`);
  }
  return value;
}

function parseBoolean(value: unknown, defaultValue = false): boolean {
  return typeof value === 'boolean' ? value : defaultValue;
}

function parseObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected object for "${field}"`);
  }
  return value as Record<string, unknown>;
}

function requiresWriteGuard(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

function requiresDestructiveGuard(method: string): boolean {
  return method.toUpperCase() === 'DELETE';
}

function toolList(): McpTool[] {
  return [
    {
      name: 'xyte_setup_status',
      description: 'Read setup status for a tenant.',
      inputSchema: {
        type: 'object',
        properties: {
          tenant: { type: 'string' }
        },
        required: ['tenant'],
        additionalProperties: false
      }
    },
    {
      name: 'xyte_config_doctor',
      description: 'Run connectivity/readiness checks for a tenant.',
      inputSchema: {
        type: 'object',
        properties: {
          tenant: { type: 'string' },
          retry_attempts: { type: 'integer', minimum: 0 },
          retry_backoff_ms: { type: 'integer', minimum: 0 }
        },
        required: ['tenant'],
        additionalProperties: false
      }
    },
    {
      name: 'xyte_list_endpoints',
      description: 'List known endpoint keys.',
      inputSchema: {
        type: 'object',
        properties: {
          tenant: { type: 'string' }
        },
        additionalProperties: false
      }
    },
    {
      name: 'xyte_describe_endpoint',
      description: 'Describe a specific endpoint key.',
      inputSchema: {
        type: 'object',
        properties: {
          endpoint_key: { type: 'string' }
        },
        required: ['endpoint_key'],
        additionalProperties: false
      }
    },
    {
      name: 'xyte_call',
      description: 'Invoke a Xyte endpoint with write guards.',
      inputSchema: {
        type: 'object',
        properties: {
          tenant: { type: 'string' },
          endpoint_key: { type: 'string' },
          path: { type: 'object', additionalProperties: { type: ['string', 'number'] } },
          query: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean', 'null'] } },
          body: {},
          allow_write: { type: 'boolean' },
          confirm: { type: 'string' }
        },
        required: ['endpoint_key'],
        additionalProperties: false
      }
    },
    {
      name: 'xyte_inspect_fleet',
      description: 'Collect deterministic fleet summary.',
      inputSchema: {
        type: 'object',
        properties: {
          tenant: { type: 'string' }
        },
        required: ['tenant'],
        additionalProperties: false
      }
    },
    {
      name: 'xyte_report_generate',
      description: 'Generate a markdown/pdf report from deep-dive JSON input.',
      inputSchema: {
        type: 'object',
        properties: {
          tenant: { type: 'string' },
          input_path: { type: 'string' },
          out_path: { type: 'string' },
          format: { type: 'string', enum: ['markdown', 'pdf'] },
          include_sensitive: { type: 'boolean' }
        },
        required: ['tenant', 'input_path', 'out_path'],
        additionalProperties: false
      }
    }
  ];
}

function success(id: JsonRpcResponse['id'], payload: unknown): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    result: payload
  };
}

function asMcpToolResult(payload: unknown, isError = false) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2)
      }
    ],
    structuredContent: payload,
    isError
  };
}

export function createMcpServer(options: McpServerOptions) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const tools = toolList();
  const ajv = new Ajv2020({ strict: false });
  const validators = new Map(
    tools.map((tool) => {
      const validator = ajv.compile(tool.inputSchema);
      return [tool.name, validator] as const;
    })
  );

  const withClient = (tenantId?: string, retry?: { attempts?: number; backoffMs?: number }) =>
    createXyteClient({
      profileStore: options.profileStore,
      keychain: options.keychain,
      tenantId,
      retryAttempts: retry?.attempts,
      retryBackoffMs: retry?.backoffMs
    });

  async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === 'xyte_setup_status') {
      const tenant = parseString(args.tenant, 'tenant');
      const client = withClient(tenant);
      const readiness = await evaluateReadiness({
        profileStore: options.profileStore,
        keychain: options.keychain,
        tenantId: tenant,
        client,
        checkConnectivity: true
      });
      return readiness;
    }

    if (name === 'xyte_config_doctor') {
      const tenant = parseString(args.tenant, 'tenant');
      const retryAttempts = Number(args.retry_attempts ?? 2);
      const retryBackoffMs = Number(args.retry_backoff_ms ?? 250);
      const client = withClient(tenant, {
        attempts: Number.isFinite(retryAttempts) ? retryAttempts : 2,
        backoffMs: Number.isFinite(retryBackoffMs) ? retryBackoffMs : 250
      });
      const readiness = await evaluateReadiness({
        profileStore: options.profileStore,
        keychain: options.keychain,
        tenantId: tenant,
        client,
        checkConnectivity: true
      });
      return {
        retryAttempts,
        retryBackoffMs,
        readiness
      };
    }

    if (name === 'xyte_list_endpoints') {
      const tenant = typeof args.tenant === 'string' ? args.tenant : undefined;
      if (tenant) {
        const client = withClient(tenant);
        return client.listTenantEndpoints(tenant);
      }
      return listEndpoints();
    }

    if (name === 'xyte_describe_endpoint') {
      return getEndpoint(parseString(args.endpoint_key, 'endpoint_key'));
    }

    if (name === 'xyte_call') {
      const endpointKey = parseString(args.endpoint_key, 'endpoint_key');
      const endpoint = getEndpoint(endpointKey);
      const method = endpoint.method.toUpperCase();
      const allowWrite = parseBoolean(args.allow_write, false);
      const confirm = typeof args.confirm === 'string' ? args.confirm : undefined;
      const tenant = typeof args.tenant === 'string' ? args.tenant : undefined;
      const requestId = `mcp-${Date.now()}`;

      if (requiresWriteGuard(method) && !allowWrite) {
        throw new Error(`Endpoint ${endpointKey} is a write operation (${method}). Set allow_write=true.`);
      }
      if (requiresDestructiveGuard(method) && confirm !== endpointKey) {
        throw new Error(`Endpoint ${endpointKey} is destructive. confirm must equal "${endpointKey}".`);
      }

      const client = withClient(tenant);
      const path = hasProperty(args, 'path') ? (parseObject(args.path, 'path') as Record<string, string | number>) : {};
      const query = hasProperty(args, 'query')
        ? (parseObject(args.query, 'query') as Record<string, string | number | boolean | null>)
        : {};

      try {
        const result = await client.callWithMeta(endpointKey, {
          requestId,
          tenantId: tenant,
          path,
          query,
          body: args.body
        });
        return buildCallEnvelope({
          requestId,
          tenantId: tenant,
          endpointKey,
          method,
          guard: {
            allowWrite,
            confirm
          },
          request: {
            path,
            query,
            body: args.body
          },
          response: {
            status: result.status,
            durationMs: result.durationMs,
            retryCount: result.retryCount,
            data: result.data
          }
        });
      } catch (error) {
        return buildCallEnvelope({
          requestId,
          tenantId: tenant,
          endpointKey,
          method,
          guard: {
            allowWrite,
            confirm
          },
          request: {
            path,
            query,
            body: args.body
          },
          error: toProblemDetails(error, `/mcp/tools/${name}`)
        });
      }
    }

    if (name === 'xyte_inspect_fleet') {
      const tenant = parseString(args.tenant, 'tenant');
      const client = withClient(tenant);
      const snapshot = await collectFleetSnapshot(client, tenant);
      return buildFleetInspect(snapshot);
    }

    if (name === 'xyte_report_generate') {
      const tenant = parseString(args.tenant, 'tenant');
      const inputPath = parseString(args.input_path, 'input_path');
      const outPath = parseString(args.out_path, 'out_path');
      const format = args.format === 'markdown' ? 'markdown' : 'pdf';
      const includeSensitive = parseBoolean(args.include_sensitive, false);
      const parsed = JSON.parse(readFileSync(inputPath, 'utf8')) as {
        schemaVersion?: string;
        tenantId?: string;
      };
      if (parsed.schemaVersion !== 'xyte.inspect.deep-dive.v1') {
        throw new Error('input_path must contain output from `xyte-cli inspect deep-dive --format json`.');
      }
      if (parsed.tenantId && parsed.tenantId !== tenant) {
        throw new Error(`Input tenant mismatch. Expected ${tenant}, got ${parsed.tenantId}.`);
      }

      return generateFleetReport({
        deepDive: parsed as any,
        format,
        outPath,
        includeSensitive
      });
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  async function dispatch(message: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
    if (message.method === 'initialize') {
      return success(message.id ?? null, {
        protocolVersion: '2025-06-18',
        serverInfo: {
          name: 'xyte-cli',
          version: '0.1.0'
        },
        capabilities: {
          tools: {
            listChanged: false
          }
        }
      });
    }

    if (message.method === 'notifications/initialized') {
      return undefined;
    }

    if (message.method === 'tools/list') {
      return success(message.id ?? null, { tools });
    }

    if (message.method === 'tools/call') {
      const params = message.params ?? {};
      const name = parseString(params.name, 'name');
      const args = hasProperty(params, 'arguments') ? parseObject(params.arguments, 'arguments') : {};
      const validator = validators.get(name);
      if (!validator) {
        throw new Error(`Unknown tool: ${name}`);
      }
      if (!validator(args)) {
        throw new Error(`Invalid arguments for ${name}: ${JSON.stringify(validator.errors ?? [])}`);
      }
      const payload = await handleToolCall(name, args);
      return success(message.id ?? null, asMcpToolResult(payload, false));
    }

    if (message.id === undefined) {
      return undefined;
    }

    return rpcError(message.id ?? null, -32601, `Method not found: ${message.method}`);
  }

  return {
    async start(): Promise<void> {
      const lineReader = createInterface({
        input: input as NodeJS.ReadableStream,
        crlfDelay: Infinity
      });

      for await (const line of lineReader) {
        if (!line.trim()) {
          continue;
        }

        let message: JsonRpcRequest;
        try {
          message = JSON.parse(line) as JsonRpcRequest;
        } catch (error) {
          writeJson(output, rpcError(null, -32700, 'Parse error', { detail: String(error) }));
          continue;
        }

        try {
          const response = await dispatch(message);
          if (response) {
            writeJson(output, response);
          }
        } catch (error) {
          const id = message.id ?? null;
          writeJson(
            output,
            rpcError(id, -32000, 'Tool execution failed', {
              problem: toProblemDetails(error, `/mcp/${message.method}`)
            })
          );
        }
      }
    }
  };
}
