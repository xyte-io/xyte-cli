import { readFileSync } from 'node:fs';

import type { Command } from 'commander';

import {
  getBuiltInFlowDefinition,
  hasBuiltInFlowDefinition,
  listBuiltInFlowDefinitions
} from '../../workflows/flow-catalog';
import { parseFlowVarOptions, runDeterministicFlow, type FlowRunMode } from '../../workflows/flow-runner';
import {
  exportFlowDefinition,
  getFlowDefinition,
  importFlowDefinition,
  listFlowDefinitions,
  saveFlowDefinition,
  updateFlowDefinition
} from '../../workflows/flow-user-definitions';
import { parseInspectProviderScope } from '../../types/settings-enums';
import { type CliContext, printJson } from '../cli-context';

function parseFlowMode(options: { plan?: boolean; apply?: boolean }): FlowRunMode {
  if (options.apply === true && options.plan === true) {
    throw new Error('Cannot specify both --plan and --apply.');
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
  const raw = readFileSync(value, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof SyntaxError ? `: ${error.message}` : '';
    throw new Error(`Failed to parse context JSON at "${value}"${detail}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Context JSON at "${value}" must be a plain object.`);
  }
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
    result[key] = String(val);
  }
  return result;
}

export function registerFlowCommands(parent: Command, ctx: CliContext): void {
  const flow = parent.command('flow').description('Deterministic flow orchestration');

  flow
    .command('list')
    .description('List built-in and custom flow IDs')
    .action(async () => {
      const builtIn = listBuiltInFlowDefinitions().map((item) => ({
        type: 'built-in' as const,
        id: item.id,
        title: item.title,
        intent: item.intent,
        writeCapable: item.writeCapable
      }));
      const customDefs = await listFlowDefinitions();
      const custom = customDefs.map((item) => ({
        type: 'custom' as const,
        id: item.id,
        title: item.title,
        description: item.description,
        basedOn: item.basedOn,
        defaults: item.defaults,
        path: item.path,
        updatedAtUtc: item.updatedAtUtc
      }));

      printJson(ctx.stdout, {
        schemaVersion: 'xyte.flow.catalog.v1',
        generatedAtUtc: new Date().toISOString(),
        builtIn,
        custom
      });
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
          throw new Error(`Custom flows must be based on a built-in flow id. Unknown: ${options.basedOn}`);
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
          throw new Error(`Custom flows must be based on a built-in flow id. Unknown: ${options.basedOn}`);
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
        throw new Error(`Imported flow ${imported.id} references unknown built-in base flow: ${imported.basedOn}`);
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
          outDir?: string;
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

        let resolvedFlowId = flowId;
        let defaults: Record<string, string> = {};
        if (!hasBuiltInFlowDefinition(flowId)) {
          const custom = await getFlowDefinition(flowId);
          if (!custom) {
            throw new Error(`Unknown flow id: ${flowId}`);
          }
          if (!hasBuiltInFlowDefinition(custom.basedOn)) {
            throw new Error(`Custom flow ${flowId} references unknown built-in base flow: ${custom.basedOn}`);
          }
          resolvedFlowId = custom.basedOn;
          defaults = custom.defaults;
        }

        const definition = getBuiltInFlowDefinition(resolvedFlowId);
        const summary = await runDeterministicFlow({
          flowId,
          resolvedFlowId,
          definition,
          tenantId: options.tenant,
          mode,
          outDir: options.outDir ?? './tmp/flow-runs',
          inspectProviderScope,
          resume: options.resume,
          context: {
            ...defaults,
            ...runtimeContext
          },
          once: options.once === true,
          strictJson: options.strictJson === true,
          profileStore: ctx.profileStore,
          secretStore: ctx.getSecretStore(),
          client: await ctx.withClient({ tenantId: options.tenant })
        });

        printJson(ctx.stdout, summary, { strictJson: options.strictJson });
        if (summary.outcome === 'failed' && summary.classifications.bug > 0) {
          process.exitCode = 1;
        }
      }
    );
}
