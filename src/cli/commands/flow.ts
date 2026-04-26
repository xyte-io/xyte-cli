import { readFileSync } from 'node:fs';

import type { Command } from 'commander';

import {
  getBuiltInFlowDefinition,
  hasBuiltInFlowDefinition,
  listBuiltInFlowDefinitions,
  type BuiltInFlowDefinition
} from '../../workflows/flow-catalog';
import { parseFlowVarOptions, runDeterministicFlow, type FlowRunMode } from '../../workflows/flow-runner';
import {
  exportFlowDefinition,
  importFlowDefinition,
  listFlowDefinitions,
  saveFlowDefinition,
  updateFlowDefinition
} from '../../workflows/flow-user-definitions';
import { parseInspectProviderScope } from '../../utils/parse-domain';
import {
  type CliContext,
  getExplicitGlobalOutput,
  printJson,
  resolveStrictJson,
  resolveTextJsonOutput
} from '../cli-context';
import { CliUserError } from '../../contracts/user-error';

function parseFlowMode(options: { plan?: boolean; apply?: boolean }): FlowRunMode {
  if (options.apply === true && options.plan === true) {
    throw new CliUserError({ summary: 'Cannot specify both --plan and --apply.' });
  }
  if (options.apply === true) {
    return 'apply';
  }
  return 'plan';
}

function parseFlowContextJson(value: string | undefined): Record<string, string> {
  if (!value) {
    return {};
  }
  let raw: string;
  try {
    raw = readFileSync(value, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new CliUserError({ summary: `Cannot read context JSON file at "${value}"${detail}` });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof SyntaxError ? `: ${error.message}` : '';
    throw new CliUserError({ summary: `Failed to parse context JSON at "${value}"${detail}` });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliUserError({ summary: `Context JSON at "${value}" must be a plain object.` });
  }
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
    result[key] = String(val);
  }
  return result;
}

function collectRequiredContext(definition: BuiltInFlowDefinition, defaults: Record<string, string> = {}): string[] {
  const provided = new Set([...Object.keys(definition.contextDefaults ?? {}), ...Object.keys(defaults)]);
  const required = new Set<string>();
  for (const step of definition.steps) {
    if (step.kind !== 'task') {
      continue;
    }
    for (const key of step.requiresContext ?? []) {
      if (!provided.has(key)) {
        required.add(key);
      }
    }
  }
  return [...required].sort();
}

function safeFirstCommand(flowId: string): string {
  return `xyte-cli flow run ${flowId} --tenant <tenant-id> --plan`;
}

function formatFlowListText(items: Array<{
  type: string;
  id: string;
  title: string;
  intent?: string;
  writeCapable?: boolean;
  requiredContext: string[];
  safeFirstCommand: string;
}>): string {
  if (!items.length) {
    return 'No flows found.\n';
  }
  return items
    .map((item) => [
      `${item.id} | ${item.type} | ${item.writeCapable ? 'write-capable' : 'read-only'}`,
      `  title: ${item.title}`,
      ...(item.intent ? [`  intent: ${item.intent}`] : []),
      `  required context: ${item.requiredContext.length ? item.requiredContext.join(', ') : 'none'}`,
      `  start: ${item.safeFirstCommand}`
    ].join('\n'))
    .join('\n\n') + '\n';
}

export function registerFlowCommands(parent: Command, ctx: CliContext): void {
  const flow = parent.command('flow').description('Deterministic flow orchestration');

  flow
    .command('list')
    .description('List built-in and custom flow IDs')
    .option('--format <format>', 'json|text')
    .action(async function (options: { format?: string }) {
      const settings = await ctx.resolveSettings();
      const output = resolveTextJsonOutput({
        output: options.format ?? getExplicitGlobalOutput(this) ?? 'json',
        stdoutIsTTY: ctx.stdoutIsTTY,
        settings
      });
      const builtIn = listBuiltInFlowDefinitions().map((item) => ({
        type: 'built-in' as const,
        id: item.id,
        title: item.title,
        intent: item.intent,
        writeCapable: item.writeCapable,
        requiredContext: collectRequiredContext(item),
        safeFirstCommand: safeFirstCommand(item.id)
      }));
      const { defs: customDefs, skipped } = await listFlowDefinitions();
      for (const { path: p, reason } of skipped) {
        ctx.stderr.write(`Warning: skipping invalid flow definition at ${p}: ${reason}\n`);
      }
      const custom: Array<{
        type: 'custom';
        id: string;
        title: string;
        intent?: string;
        writeCapable: boolean;
        requiredContext: string[];
        safeFirstCommand: string;
        basedOn: string;
        defaults: Record<string, string>;
        path: string;
        updatedAtUtc: string;
      }> = [];
      for (const item of customDefs) {
        if (!hasBuiltInFlowDefinition(item.basedOn)) {
          ctx.stderr.write(`Warning: skipping invalid flow definition at ${item.path}: unknown basedOn ${item.basedOn}\n`);
          continue;
        }
        const basedOn = getBuiltInFlowDefinition(item.basedOn);
        custom.push({
          type: 'custom',
          id: item.id,
          title: item.title,
          intent: item.description,
          writeCapable: basedOn.writeCapable,
          requiredContext: collectRequiredContext(basedOn, item.defaults),
          safeFirstCommand: safeFirstCommand(item.id),
          basedOn: item.basedOn,
          defaults: item.defaults,
          path: item.path,
          updatedAtUtc: item.updatedAtUtc
        });
      }

      if (output === 'text') {
        ctx.stdout.write(formatFlowListText([...builtIn, ...custom]));
        return;
      }

      printJson(ctx.stdout, {
        schemaVersion: 'xyte.flow.catalog.v1',
        generatedAtUtc: new Date().toISOString(),
        builtIn,
        custom
      }, { strictJson: resolveStrictJson({ settings }) });
    });

  flow
    .command('create')
    .description('Create a custom shareable flow definition (aliasing a built-in flow)')
    .argument('<flowId>', 'Custom flow id (flow.<name>)')
    .requiredOption('--based-on <flowId>', 'Built-in flow id to alias')
    .option('--title <title>', 'Flow title')
    .option('--description <description>', 'Flow description')
    .option('--context-json <path>', 'JSON object of default context values')
    .option(
      '--var <key=value>',
      'Default context override (repeatable)',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[]
    )
    .option('--force', 'Overwrite if flow already exists')
    .action(
      async (
        flowId: string,
        options: {
          basedOn: string;
          title?: string;
          description?: string;
          contextJson?: string;
          var?: string[];
          force?: boolean;
        }
      ) => {
        if (!hasBuiltInFlowDefinition(options.basedOn)) {
          throw new CliUserError({ summary: `Custom flows must be based on a built-in flow id. Unknown: ${options.basedOn}` });
        }
        const defaults = {
          ...parseFlowContextJson(options.contextJson),
          ...parseFlowVarOptions(options.var)
        };
        const saved = await saveFlowDefinition({
          flowId,
          basedOn: options.basedOn,
          title: options.title,
          description: options.description,
          defaults,
          overwrite: options.force === true
        });
        printJson(ctx.stdout, saved);
      }
    );

  flow
    .command('edit')
    .description('Edit a custom flow definition')
    .argument('<flowId>', 'Custom flow id')
    .option('--based-on <flowId>', 'Built-in flow id to alias')
    .option('--title <title>', 'Flow title')
    .option('--description <description>', 'Flow description')
    .option('--context-json <path>', 'JSON object of default context values')
    .option(
      '--var <key=value>',
      'Default context override (repeatable)',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[]
    )
    .option('--replace-defaults', 'Replace defaults instead of merging')
    .action(
      async (
        flowId: string,
        options: {
          basedOn?: string;
          title?: string;
          description?: string;
          contextJson?: string;
          var?: string[];
          replaceDefaults?: boolean;
        }
      ) => {
        if (options.basedOn && !hasBuiltInFlowDefinition(options.basedOn)) {
          throw new CliUserError({ summary: `Custom flows must be based on a built-in flow id. Unknown: ${options.basedOn}` });
        }
        const mergedDefaults = {
          ...parseFlowContextJson(options.contextJson),
          ...parseFlowVarOptions(options.var)
        };
        const defaultsProvided = Object.keys(mergedDefaults).length > 0 || options.replaceDefaults === true;
        const updated = await updateFlowDefinition({
          flowId,
          basedOn: options.basedOn,
          title: options.title,
          description: options.description,
          ...(defaultsProvided ? { defaults: mergedDefaults } : {}),
          replaceDefaults: options.replaceDefaults === true
        });
        printJson(ctx.stdout, updated);
      }
    );

  flow
    .command('share')
    .description('Export a custom flow definition for sharing')
    .argument('<flowId>', 'Custom flow id')
    .requiredOption('--out <path>', 'Export path')
    .action(async (flowId: string, options: { out: string }) => {
      printJson(ctx.stdout, await exportFlowDefinition({ flowId, outPath: options.out }));
    });

  flow
    .command('import')
    .description('Import a shared custom flow definition')
    .requiredOption('--file <path>', 'Path to a shared flow definition JSON')
    .option('--force', 'Overwrite existing flow definition')
    .action(async (options: { file: string; force?: boolean }) => {
      const imported = await importFlowDefinition({ filePath: options.file, force: options.force === true });
      if (!hasBuiltInFlowDefinition(imported.basedOn)) {
        throw new CliUserError({ summary: `Imported flow ${imported.id} references unknown built-in base flow: ${imported.basedOn}` });
      }
      printJson(ctx.stdout, imported);
    });

  flow
    .command('run')
    .description('Run a deterministic flow by id')
    .argument('<flowId>', 'Flow id (built-in or custom alias)')
    .requiredOption('--tenant <tenantId>', 'Tenant id')
    .option('--plan', 'Dry mode (default)')
    .option('--apply', 'Advance the next human gate')
    .option('--resume <runRef>', 'Resume from a previous run id or bundle path')
    .option('--out-dir <path>', 'Flow run bundle root directory', './tmp/flow-runs')
    .option('--inspect-provider-scope <scope>', 'organization|partner|auto')
    .option('--context-json <path>', 'JSON object file for flow context')
    .option(
      '--var <key=value>',
      'Flow context override (repeatable)',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[]
    )
    .option('--once', 'Shorten long watch loops')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(
      async (
        flowId: string,
        options: {
          tenant: string;
          plan?: boolean;
          apply?: boolean;
          resume?: string;
          outDir: string;
          inspectProviderScope?: string;
          contextJson?: string;
          var?: string[];
          once?: boolean;
          strictJson?: boolean;
        }
      ) => {
        const mode = parseFlowMode(options);
        const inspectProviderScope = options.inspectProviderScope
          ? parseInspectProviderScope(options.inspectProviderScope)
          : undefined;
        const runtimeContext = {
          ...parseFlowContextJson(options.contextJson),
          ...parseFlowVarOptions(options.var)
        };

        const settings = await ctx.resolveSettings();
        const summary = await runDeterministicFlow({
          flowId,
          tenantId: options.tenant,
          mode,
          outDir: options.outDir,
          inspectProviderScope,
          resume: options.resume,
          context: runtimeContext,
          once: options.once === true,
          strictJson: options.strictJson === true,
          profileStore: ctx.profileStore,
          secretStore: ctx.getSecretStore(),
          client: await ctx.withClient({ tenantId: options.tenant })
        });

        printJson(ctx.stdout, summary, { strictJson: resolveStrictJson({ strictJson: options.strictJson, settings }) });
        if (summary.outcome === 'failed' && summary.classifications.bug > 0) {
          process.exitCode = 1;
        }
      }
    );
}
