import type { Command } from 'commander';

import { CliUserError } from '../../contracts/user-error';
import type { UtilityInputFormat } from '../../utils/input-parser';
import { runEdgeClaim, runEdgeClaimBatch, validateEdgeClaimRow } from '../../workflows/edge-claim';
import { runEdgePing } from '../../workflows/edge-ping';
import { parsePositiveInt } from '../../workflows/edge-poll';
import {
  type CliContext,
  getExplicitGlobalOutput,
  printJson,
  requireTenantId,
  resolveStrictJson,
  resolveTextJsonOutput
} from '../cli-context';

interface EdgeClaimOptions {
  tenant?: string;
  output?: string;
  proxyId: string;
  deviceIp: string;
  deviceModelId: string;
  spaceId: string;
  displayName?: string;
  skipConnectivityCheck?: boolean;
  customParameters?: string;
  customPartnerName?: string;
  customModelName?: string;
  pollIntervalMs?: string;
  pollTimeoutMs?: string;
  plan?: boolean;
  apply?: boolean;
  strictJson?: boolean;
}

interface EdgeClaimBatchOptions {
  tenant?: string;
  output?: string;
  input: string;
  inputFormat?: string;
  apply?: boolean;
  plan?: boolean;
  resumeArtifact?: string;
  report?: string;
  skipConnectivityCheck?: boolean;
  pollIntervalMs?: string;
  pollTimeoutMs?: string;
  strictJson?: boolean;
}

interface EdgeStatusOptions {
  tenant?: string;
  output?: string;
  proxyId: string;
  deviceIp: string;
  strictJson?: boolean;
}

interface EdgePingOptions extends EdgeStatusOptions {
  pollIntervalMs?: string;
  pollTimeoutMs?: string;
  plan?: boolean;
  apply?: boolean;
}

function parseEdgeInputFormat(value: string | undefined): UtilityInputFormat {
  const normalized = (value ?? 'auto').trim().toLowerCase();
  const allowed: UtilityInputFormat[] = ['auto', 'csv', 'json', 'jsonl'];
  if (!allowed.includes(normalized as UtilityInputFormat)) {
    throw new CliUserError({ summary: `Invalid input format: ${value}. Use auto|csv|json|jsonl.` });
  }
  return normalized as UtilityInputFormat;
}

function validateMutationMode(plan: boolean | undefined, apply: boolean | undefined, commandLabel: string): boolean {
  if (plan && apply) {
    throw new CliUserError({ summary: `${commandLabel} accepts either --plan or --apply, not both.` });
  }
  return apply === true;
}

function resolveEdgePollOptions(options: {
  pollIntervalMs?: string;
  pollTimeoutMs?: string;
}): { intervalMs?: number; timeoutMs?: number } {
  return {
    intervalMs: parsePositiveInt(options.pollIntervalMs, '--poll-interval-ms'),
    timeoutMs: parsePositiveInt(options.pollTimeoutMs, '--poll-timeout-ms')
  };
}

function writeEdgeText(ctx: CliContext, value: unknown): void {
  ctx.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function handleEdgeClaim(ctx: CliContext, options: EdgeClaimOptions): Promise<void> {
  const settings = await ctx.resolveSettings(options.tenant ? { 'defaults.tenant': options.tenant } : {});
  const tenantId = options.tenant ?? settings.values.defaults.tenant;
  requireTenantId(tenantId, 'edge claim');
  const apply = validateMutationMode(options.plan, options.apply, 'edge claim');
  const output = resolveTextJsonOutput({
    output: options.output,
    stdoutIsTTY: ctx.stdoutIsTTY,
    settings
  });
  const validation = validateEdgeClaimRow(
    {
      proxy_id: options.proxyId,
      device_ip: options.deviceIp,
      device_model_id: options.deviceModelId,
      space_id: options.spaceId,
      display_name: options.displayName,
      skip_connectivity_check: options.skipConnectivityCheck,
      custom_parameters: options.customParameters,
      custom_partner_name: options.customPartnerName,
      custom_model_name: options.customModelName
    },
    1
  );
  if (!validation.ok) {
    throw new CliUserError({ summary: `Invalid edge claim input: ${validation.reason}` });
  }
  const pollOptions = resolveEdgePollOptions(options);
  const strictJson = resolveStrictJson({ strictJson: options.strictJson, settings });
  if (!apply) {
    const payload = {
      schemaVersion: 'xyte.edge.claim.plan.v1',
      tenantId,
      mode: 'plan',
      planned: validation.row
    };
    if (output === 'text') {
      writeEdgeText(ctx, payload);
      return;
    }
    printJson(ctx.stdout, payload, { strictJson });
    return;
  }
  const client = await ctx.withClient({ tenantId });
  const outcome = await runEdgeClaim({
    client,
    tenantId,
    row: validation.row,
    pollOptions
  });
  const payload = { schemaVersion: 'xyte.edge.claim.v1', tenantId, mode: 'apply', outcome };
  if (output === 'text') {
    writeEdgeText(ctx, payload);
  } else {
    printJson(ctx.stdout, payload, { strictJson });
  }
  if (outcome.disposition !== 'succeeded' && outcome.disposition !== 'already-claimed') {
    process.exitCode = 1;
  }
}

async function handleEdgeClaimBatch(ctx: CliContext, options: EdgeClaimBatchOptions): Promise<void> {
  const settings = await ctx.resolveSettings(options.tenant ? { 'defaults.tenant': options.tenant } : {});
  const tenantId = options.tenant ?? settings.values.defaults.tenant;
  requireTenantId(tenantId, 'edge claim-batch');
  const apply = validateMutationMode(options.plan, options.apply, 'edge claim-batch');
  const output = resolveTextJsonOutput({
    output: options.output,
    stdoutIsTTY: ctx.stdoutIsTTY,
    settings
  });
  const pollOptions = resolveEdgePollOptions(options);
  const client = await ctx.withClient({ tenantId });
  const result = await runEdgeClaimBatch({
    client,
    tenantId,
    inputPath: options.input,
    inputFormat: parseEdgeInputFormat(options.inputFormat),
    apply,
    reportPath: options.report,
    resumePath: options.resumeArtifact,
    skipConnectivityCheck: options.skipConnectivityCheck,
    pollOptions
  });
  if (output === 'text') {
    writeEdgeText(ctx, result);
  } else {
    printJson(ctx.stdout, result, { strictJson: resolveStrictJson({ strictJson: options.strictJson, settings }) });
  }
  const { failed, rejected, timeout, aborted, proxyOffline, pingFailed } = result.totals;
  if (
    result.stoppedEarly ||
    failed > 0 ||
    rejected > 0 ||
    timeout > 0 ||
    aborted > 0 ||
    proxyOffline > 0 ||
    pingFailed > 0
  ) {
    process.exitCode = 1;
  }
}

async function handleEdgeClaimStatus(ctx: CliContext, options: EdgeStatusOptions): Promise<void> {
  const settings = await ctx.resolveSettings(options.tenant ? { 'defaults.tenant': options.tenant } : {});
  const tenantId = options.tenant ?? settings.values.defaults.tenant;
  requireTenantId(tenantId, 'edge claim-status');
  const output = resolveTextJsonOutput({
    output: options.output,
    stdoutIsTTY: ctx.stdoutIsTTY,
    settings
  });
  const client = await ctx.withClient({ tenantId });
  const response = await client.callWithMeta('organization.edge.getClaimStatus', {
    tenantId,
    query: { proxy_id: options.proxyId, device_ip: options.deviceIp }
  });
  const payload = { schemaVersion: 'xyte.edge.claim-status.v1', tenantId, response: response.data };
  if (output === 'text') {
    writeEdgeText(ctx, payload);
  } else {
    printJson(ctx.stdout, payload, { strictJson: resolveStrictJson({ strictJson: options.strictJson, settings }) });
  }
}

async function handleEdgePing(ctx: CliContext, options: EdgePingOptions): Promise<void> {
  const settings = await ctx.resolveSettings(options.tenant ? { 'defaults.tenant': options.tenant } : {});
  const tenantId = options.tenant ?? settings.values.defaults.tenant;
  requireTenantId(tenantId, 'edge ping');
  const apply = validateMutationMode(options.plan, options.apply, 'edge ping');
  const pollOptions = resolveEdgePollOptions(options);
  const strictJson = resolveStrictJson({ strictJson: options.strictJson, settings });
  const output = resolveTextJsonOutput({
    output: options.output,
    stdoutIsTTY: ctx.stdoutIsTTY,
    settings
  });
  if (!apply) {
    const payload = {
      schemaVersion: 'xyte.edge.ping.plan.v1',
      tenantId,
      mode: 'plan',
      planned: { proxy_id: options.proxyId, device_ip: options.deviceIp }
    };
    if (output === 'text') {
      writeEdgeText(ctx, payload);
      return;
    }
    printJson(ctx.stdout, payload, { strictJson });
    return;
  }
  const client = await ctx.withClient({ tenantId });
  const outcome = await runEdgePing({
    client,
    tenantId,
    proxy_id: options.proxyId,
    device_ip: options.deviceIp,
    pollOptions
  });
  if (output === 'text') {
    writeEdgeText(ctx, outcome);
  } else {
    printJson(ctx.stdout, outcome, { strictJson });
  }
  if (outcome.disposition !== 'succeeded') {
    process.exitCode = 1;
  }
}

async function handleEdgePingStatus(ctx: CliContext, options: EdgeStatusOptions): Promise<void> {
  const settings = await ctx.resolveSettings(options.tenant ? { 'defaults.tenant': options.tenant } : {});
  const tenantId = options.tenant ?? settings.values.defaults.tenant;
  requireTenantId(tenantId, 'edge ping-status');
  const output = resolveTextJsonOutput({
    output: options.output,
    stdoutIsTTY: ctx.stdoutIsTTY,
    settings
  });
  const client = await ctx.withClient({ tenantId });
  const response = await client.callWithMeta('organization.edge.getPingStatus', {
    tenantId,
    query: { proxy_id: options.proxyId, device_ip: options.deviceIp }
  });
  const payload = { schemaVersion: 'xyte.edge.ping-status.v1', tenantId, response: response.data };
  if (output === 'text') {
    writeEdgeText(ctx, payload);
  } else {
    printJson(ctx.stdout, payload, { strictJson: resolveStrictJson({ strictJson: options.strictJson, settings }) });
  }
}

export function registerEdgeCommands(parent: Command, ctx: CliContext): void {
  const edge = parent
    .command('edge')
    .description('Claim and probe devices behind Xyte Edge proxies');
  edge.addHelpText(
    'after',
    [
      '',
      'Examples:',
      '  xyte-cli edge claim --tenant <tenant-id> --proxy-id <proxy-id> --device-ip 10.0.0.10 --device-model-id <model-id> --space-id 123 --plan',
      '  xyte-cli edge claim-batch --tenant <tenant-id> --input ./prepared/organization-edge-startclaim.csv --plan --report ./artifacts/edge-claim.plan.ndjson',
      '  xyte-cli edge claim-batch --tenant <tenant-id> --input ./prepared/organization-edge-startclaim.csv --apply --report ./artifacts/edge-claim.report.ndjson --resume-artifact ./artifacts/edge-claim.resume.ndjson',
      '  xyte-cli edge claim-batch --tenant <tenant-id> --input ./prepared/organization-edge-startclaim.csv --plan --skip-connectivity-check',
      '  xyte-cli edge claim-status --tenant <tenant-id> --proxy-id <proxy-id> --device-ip 10.0.0.10',
      '  xyte-cli edge ping --tenant <tenant-id> --proxy-id <proxy-id> --device-ip 10.0.0.10 --plan',
      '  xyte-cli edge ping --tenant <tenant-id> --proxy-id <proxy-id> --device-ip 10.0.0.10 --apply',
      '  xyte-cli edge ping-status --tenant <tenant-id> --proxy-id <proxy-id> --device-ip 10.0.0.10'
    ].join('\n')
  );

  edge
    .command('claim')
    .description('Initiate a single edge-device claim (async) and poll to terminal state')
    .requiredOption('--proxy-id <id>', 'Edge proxy id')
    .requiredOption('--device-ip <ip>', 'Device IP or hostname behind the edge')
    .requiredOption('--device-model-id <id>', 'Device model id (catalog uuid)')
    .requiredOption('--space-id <id>', 'Target space id (positive integer)')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--display-name <name>', 'Optional display name override')
    .option('--skip-connectivity-check', 'Skip edge connectivity check')
    .option('--custom-parameters <json>', 'JSON object of custom parameters')
    .option('--custom-partner-name <name>', 'Custom partner name override')
    .option('--custom-model-name <name>', 'Custom model name override')
    .option('--poll-interval-ms <ms>', 'Status poll interval (ms)')
    .option('--poll-timeout-ms <ms>', 'Status poll timeout (ms)')
    .option('--plan', 'Print the planned claim without calling the API')
    .option('--apply', 'Execute the claim')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(async function (options: EdgeClaimOptions) {
      await handleEdgeClaim(ctx, { ...options, output: getExplicitGlobalOutput(this) });
    });

  edge
    .command('claim-batch')
    .description('Apply many edge-device claims from a prepared CSV and poll each to terminal state')
    .requiredOption('--input <path>', 'Path to organization-edge-startclaim.csv (or JSON/JSONL)')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--input-format <format>', 'auto|csv|json|jsonl', 'auto')
    .option('--plan', 'Print planned actions without calling the API')
    .option('--apply', 'Execute claims for every row')
    .option('--resume-artifact <path>', 'NDJSON resume artifact (skip rows already marked succeeded or already-claimed)')
    .option('--report <path>', 'Write NDJSON row report file')
    .option('--skip-connectivity-check', 'Skip pre-claim ping for rows without skip_connectivity_check=false')
    .option('--poll-interval-ms <ms>', 'Status poll interval (ms)')
    .option('--poll-timeout-ms <ms>', 'Status poll timeout (ms)')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(async function (options: EdgeClaimBatchOptions) {
      await handleEdgeClaimBatch(ctx, { ...options, output: getExplicitGlobalOutput(this) });
    });

  edge
    .command('claim-status')
    .description('Read the current claim status for a device behind an edge proxy')
    .requiredOption('--proxy-id <id>', 'Edge proxy id')
    .requiredOption('--device-ip <ip>', 'Device IP or hostname behind the edge')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(async function (options: EdgeStatusOptions) {
      await handleEdgeClaimStatus(ctx, { ...options, output: getExplicitGlobalOutput(this) });
    });

  edge
    .command('ping')
    .description('Probe connectivity for a device behind an edge proxy (async, polled)')
    .requiredOption('--proxy-id <id>', 'Edge proxy id')
    .requiredOption('--device-ip <ip>', 'Device IP or hostname behind the edge')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--poll-interval-ms <ms>', 'Status poll interval (ms)')
    .option('--poll-timeout-ms <ms>', 'Status poll timeout (ms)')
    .option('--plan', 'Print the planned ping without calling the API')
    .option('--apply', 'Execute the ping')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(async function (options: EdgePingOptions) {
      await handleEdgePing(ctx, { ...options, output: getExplicitGlobalOutput(this) });
    });

  edge
    .command('ping-status')
    .description('Read the current ping status for a device behind an edge proxy')
    .requiredOption('--proxy-id <id>', 'Edge proxy id')
    .requiredOption('--device-ip <ip>', 'Device IP or hostname behind the edge')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(async function (options: EdgeStatusOptions) {
      await handleEdgePingStatus(ctx, { ...options, output: getExplicitGlobalOutput(this) });
    });
}
