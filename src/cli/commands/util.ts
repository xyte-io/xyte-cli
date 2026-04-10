import type { Command } from 'commander';

import { CliUserError } from '../../contracts/user-error';
import type { UtilityInputFormat } from '../../utils/input-parser';
import type { UtilityPreparePrimaryFormat } from '../../workflows/utility-action-profiles';
import { runUtilityPrepare, listUtilityPrepareActions } from '../../workflows/utility-prepare';
import { runSpaceImportTree } from '../../workflows/utility-commands';
import { runDeviceMatch } from '../../workflows/device-match';
import { runMoveDevices } from '../../workflows/move-devices';
import {
  type CliContext,
  getExplicitGlobalOutput,
  printJson,
  requireTenantId,
  resolveStrictJson,
  resolveTextJsonOutput
} from '../cli-context';

function parseUtilityPreparePrimaryFormat(value: string | undefined): UtilityPreparePrimaryFormat | undefined {
  if (!value || !value.trim()) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized !== 'csv' && normalized !== 'jsonl') {
    throw new Error(`Invalid primary format: ${value}. Use csv|jsonl.`);
  }
  return normalized as UtilityPreparePrimaryFormat;
}

function parseUtilityInputFormat(value: string | undefined): UtilityInputFormat {
  const normalized = (value ?? 'auto').trim().toLowerCase();
  const allowed: UtilityInputFormat[] = ['auto', 'csv', 'json', 'jsonl'];
  if (!allowed.includes(normalized as UtilityInputFormat)) {
    throw new Error(`Invalid input format: ${value}. Use auto|csv|json|jsonl.`);
  }
  return normalized as UtilityInputFormat;
}

async function handleUtilPrepare(
  ctx: CliContext,
  options: {
    input: string;
    action: string;
    tenant?: string;
    outputDir?: string;
    primaryFormat?: string;
    force?: boolean;
    strictJson?: boolean;
  }
): Promise<void> {
  const settings = await ctx.resolveSettings(options.tenant ? { 'defaults.tenant': options.tenant } : {});
  const result = runUtilityPrepare({
    inputPath: options.input,
    actionKey: options.action,
    outputDir: options.outputDir,
    tenantId: options.tenant ?? settings.values.defaults.tenant,
    primaryFormat: parseUtilityPreparePrimaryFormat(options.primaryFormat),
    force: options.force === true
  });
  printJson(ctx.stdout, result, { strictJson: resolveStrictJson({ strictJson: options.strictJson, settings }) });
}

async function handleUtilListActions(
  ctx: CliContext,
  options: {
    output?: string;
    format?: string;
    entity?: string;
    includeGeneric?: boolean;
    strictJson?: boolean;
  }
): Promise<void> {
  const settings = await ctx.resolveSettings();
  const output = resolveTextJsonOutput({
    output: options.output,
    format: options.format,
    stdoutIsTTY: ctx.stdoutIsTTY,
    settings
  });
  const actions = listUtilityPrepareActions({
    entity: options.entity,
    includeGeneric: options.includeGeneric !== false
  });
  if (output === 'json') {
    printJson(ctx.stdout, actions, { strictJson: resolveStrictJson({ strictJson: options.strictJson, settings }) });
    return;
  }
  if (!actions.length) {
    ctx.stdout.write('No utility actions found.\n');
    return;
  }
  for (const action of actions) {
    ctx.stdout.write(
      `${action.actionKey} | entity=${action.entity} | mode=${action.mode} | execution=${action.executionSupport}\n`
    );
  }
}

async function handleUtilImportTree(
  ctx: CliContext,
  options: {
    tenant?: string;
    input: string;
    inputFormat?: string;
    pathField?: string;
    spaceTypeField?: string;
    configField?: string;
    apply?: boolean;
    continueOnError?: boolean;
    report?: string;
    strictJson?: boolean;
  }
): Promise<void> {
  const settings = await ctx.resolveSettings(options.tenant ? { 'defaults.tenant': options.tenant } : {});
  const tenantId = options.tenant ?? settings.values.defaults.tenant;
  requireTenantId(tenantId, 'util import-tree');
  const client = await ctx.withClient({ tenantId });
  const result = await runSpaceImportTree({
    client,
    tenantId,
    inputPath: options.input,
    inputFormat: parseUtilityInputFormat(options.inputFormat),
    apply: options.apply === true,
    continueOnError: options.continueOnError === true,
    reportPath: options.report,
    pathField: options.pathField,
    spaceTypeField: options.spaceTypeField,
    configField: options.configField
  });
  printJson(ctx.stdout, result, { strictJson: resolveStrictJson({ strictJson: options.strictJson, settings }) });
  if (result.totals.failed > 0) {
    process.exitCode = 1;
  }
}

async function handleUtilMoveDevices(
  ctx: CliContext,
  options: {
    tenant?: string;
    input: string;
    inputFormat?: string;
    apply?: boolean;
    continueOnError?: boolean;
    report?: string;
    strictJson?: boolean;
  }
): Promise<void> {
  const settings = await ctx.resolveSettings(options.tenant ? { 'defaults.tenant': options.tenant } : {});
  const tenantId = options.tenant ?? settings.values.defaults.tenant;
  requireTenantId(tenantId, 'util move-devices');
  const client = await ctx.withClient({ tenantId });
  const result = await runMoveDevices({
    client,
    tenantId,
    inputPath: options.input,
    inputFormat: parseUtilityInputFormat(options.inputFormat),
    apply: options.apply === true,
    continueOnError: options.continueOnError === true,
    reportPath: options.report
  });
  printJson(ctx.stdout, result, { strictJson: resolveStrictJson({ strictJson: options.strictJson, settings }) });
  if (result.totals.failed > 0) {
    process.exitCode = 1;
  }
}

async function handleUtilMatch(
  ctx: CliContext,
  options: {
    tenant?: string;
    source: string;
    target: string;
    sourceField: string;
    targetField: string;
    out?: string;
    strictJson?: boolean;
  }
): Promise<void> {
  const settings = await ctx.resolveSettings(options.tenant ? { 'defaults.tenant': options.tenant } : {});
  if (!options.out) {
    throw new CliUserError({
      summary: 'Missing output path for util match.',
      suggestedCommands: ['Use --out <path>']
    });
  }
  const result = await runDeviceMatch({
    sourcePath: options.source,
    targetPath: options.target,
    sourceField: options.sourceField,
    targetField: options.targetField,
    outputPath: options.out,
    tenantId: options.tenant ?? settings.values.defaults.tenant
  });
  printJson(ctx.stdout, result, { strictJson: resolveStrictJson({ strictJson: options.strictJson, settings }) });
}

export function registerUtilCommands(parent: Command, ctx: CliContext): void {
  const util = parent.command('util').description('Utility preprocessing and import workflows');
  util.addHelpText(
    'after',
    [
      '',
      'Examples:',
      '  xyte-cli util list-actions --output text',
      '  xyte-cli util prepare --action organization.devices.claimDevice --tenant <tenant-id> --input ./claims.csv',
      '  xyte-cli util import-tree --tenant <tenant-id> --input ./space-import.csv',
      '  xyte-cli util move-devices --tenant <tenant-id> --input ./device-moves.csv',
      '  xyte-cli util match --source ./source-devices.json --target ./target-spaces.json --source-field name --target-field name --out ./device-moves.csv'
    ].join('\n')
  );
  util
    .command('prepare')
    .description('Build preprocessing contract and scaffold canonical files for one action')
    .requiredOption('--input <path>', 'Input source path')
    .requiredOption('--action <actionKey>', 'Action key (endpoint key or space.import-tree)')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--output-dir <path>', 'Directory for scaffolded files')
    .option('--primary-format <format>', 'csv|jsonl')
    .option('--force', 'Overwrite scaffold files if they already exist')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(
      async (options: {
        input: string;
        action: string;
        tenant?: string;
        outputDir?: string;
        primaryFormat?: string;
        force?: boolean;
        strictJson?: boolean;
      }) => {
        await handleUtilPrepare(ctx, options);
      }
    );

  util
    .command('list-actions')
    .description('List utility prepare action keys')
    .option('--entity <entity>', 'Filter by entity')
    .option('--include-generic', 'Include generic profiles', true)
    .option('--no-include-generic', 'Exclude generic profiles')
    .option('--format <format>', 'json|text')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(async function (options: {
      entity?: string;
      includeGeneric?: boolean;
      format?: string;
      strictJson?: boolean;
    }) {
      await handleUtilListActions(ctx, {
        ...options,
        output: getExplicitGlobalOutput(this)
      });
    });

  util
    .command('import-tree')
    .description('Create or find spaces from file-defined paths')
    .requiredOption('--input <path>', 'Input path (CSV/JSON/JSONL)')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--input-format <format>', 'auto|csv|json|jsonl', 'auto')
    .option('--path-field <name>', 'Input column/field for full path', 'path')
    .option('--space-type-field <name>', 'Input column/field for space type', 'space_type')
    .option('--config-field <name>', 'Input column/field for config object', 'config')
    .option('--apply', 'Apply changes (default is dry-run)')
    .option('--continue-on-error', 'Continue processing rows after failures')
    .option('--report <path>', 'Write NDJSON row report file')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(
      async (options: {
        tenant?: string;
        input: string;
        inputFormat?: string;
        pathField?: string;
        spaceTypeField?: string;
        configField?: string;
        apply?: boolean;
        continueOnError?: boolean;
        report?: string;
        strictJson?: boolean;
      }) => {
        await handleUtilImportTree(ctx, options);
      }
    );

  util
    .command('move-devices')
    .description('Validate and move devices into target spaces from a file-defined mapping')
    .requiredOption('--input <path>', 'Input path (CSV/JSON/JSONL)')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--input-format <format>', 'auto|csv|json|jsonl', 'auto')
    .option('--apply', 'Apply changes (default is dry-run)')
    .option('--continue-on-error', 'Continue processing rows after failures')
    .option('--report <path>', 'Write NDJSON row report file')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(
      async (options: {
        tenant?: string;
        input: string;
        inputFormat?: string;
        apply?: boolean;
        continueOnError?: boolean;
        report?: string;
        strictJson?: boolean;
      }) => {
        await handleUtilMoveDevices(ctx, options);
      }
    );

  util
    .command('match')
    .description('Compute deterministic device-to-space matches and emit a move CSV plus JSON summary')
    .requiredOption('--source <path>', 'Source device JSON path')
    .requiredOption('--target <path>', 'Target space JSON path')
    .requiredOption('--source-field <name>', 'Source field containing the device name')
    .requiredOption('--target-field <name>', 'Target field containing the target space name')
    .requiredOption('--out <path>', 'Output CSV path')
    .option('--tenant <tenantId>', 'Tenant id override for summary metadata')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(async (options: {
      tenant?: string;
      source: string;
      target: string;
      sourceField: string;
      targetField: string;
      out: string;
      strictJson?: boolean;
    }) => {
      await handleUtilMatch(ctx, options);
    });
}
