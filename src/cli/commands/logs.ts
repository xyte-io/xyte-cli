import type { Command } from 'commander';

import { readCliActionLog } from '../action-log-store';
import { runActionLogViewer } from '../action-log-viewer';
import {
  pruneCliActionLogFiles,
  listCliActionLogFiles,
  extractCommandPathFromLogEntry,
  resolveCliActionLogPath,
  type CliActionLogEntry
} from '../action-logger';
import { isRecord } from '../../utils/json';
import { formatBytes } from '../format-bytes';
import { parsePositiveIntegerOption, parsePositiveNumberOption } from '../parse-options';
import {
  type CliContext,
  getExplicitGlobalOutput,
  printJson,
  resolveStrictJson,
  resolveTextJsonOutput
} from '../cli-context';

function formatActionLogText(entry: CliActionLogEntry): string {
  const commandPath = extractCommandPathFromLogEntry(entry) ?? '-';
  const data = isRecord(entry.data) ? entry.data : undefined;
  const duration =
    typeof data?.durationMs === 'number' && Number.isFinite(data.durationMs) ? `${Math.round(data.durationMs)}ms` : '-';
  return `${entry.timestamp} | ${entry.level} | ${entry.event} | ${commandPath} | ${duration}`;
}

export function registerLogsCommands(parent: Command, ctx: CliContext): void {
  const logs = parent.command('logs').description('Inspect persisted CLI action logs');

  logs
    .command('list')
    .description('List action log entries')
    .option('--path <path>', 'Action log file override')
    .option('--limit <n>', 'Max number of entries', '100')
    .option('--event <event>', 'Filter by event name')
    .option('--command <text>', 'Filter by command path substring')
    .option('--format <format>', 'text|json', 'text')
    .action(
      async (
        options: {
          path?: string;
          limit?: string;
          event?: string;
          command?: string;
          format?: string;
        },
        command: Command
      ) => {
        const settings = await ctx.resolveSettings();
        const limit = parsePositiveIntegerOption(options.limit, 100, 'limit');
        const result = readCliActionLog({
          path: options.path,
          limit,
          event: options.event,
          command: options.command
        });

        if (
          resolveTextJsonOutput({
            output: getExplicitGlobalOutput(command),
            format: options.format,
            stdoutIsTTY: ctx.stdoutIsTTY,
            settings
          }) === 'json'
        ) {
          printJson(
            ctx.stdout,
            {
              schemaVersion: 'xyte.cli.action-log.v1',
              path: result.path,
              count: result.entries.length,
              parseErrors: result.parseErrors,
              entries: result.entries
            },
            { strictJson: resolveStrictJson({ settings }) }
          );
          return;
        }

        if (!result.entries.length) {
          ctx.stdout.write(`No action log entries found at ${result.path}\n`);
          return;
        }

        for (const entry of result.entries) {
          ctx.stdout.write(`${formatActionLogText(entry)}\n`);
        }
        if (result.parseErrors > 0) {
          ctx.stdout.write(`Ignored ${result.parseErrors} malformed log line(s).\n`);
        }
      }
    );

  logs
    .command('stats')
    .description('Show action log storage stats')
    .option('--path <path>', 'Action log file override')
    .option('--format <format>', 'text|json', 'text')
    .action(async (options: { path?: string; format?: string }, command: Command) => {
      const settings = await ctx.resolveSettings();
      const logPath = resolveCliActionLogPath(options.path);
      const files = listCliActionLogFiles(logPath);
      const totalBytes = files.reduce((sum, item) => sum + item.sizeBytes, 0);

      if (
        resolveTextJsonOutput({
          output: getExplicitGlobalOutput(command),
          format: options.format,
          stdoutIsTTY: ctx.stdoutIsTTY,
          settings
        }) === 'json'
      ) {
        printJson(
          ctx.stdout,
          {
            schemaVersion: 'xyte.cli.action-log.stats.v1',
            path: logPath,
            fileCount: files.length,
            totalBytes,
            files: files.map((item) => ({
              path: item.path,
              kind: item.kind,
              index: item.index,
              sizeBytes: item.sizeBytes,
              modifiedAtUtc: item.modifiedAtUtc
            }))
          },
          { strictJson: resolveStrictJson({ settings }) }
        );
        return;
      }

      ctx.stdout.write(`Path: ${logPath}\n`);
      ctx.stdout.write(`Files: ${files.length}\n`);
      ctx.stdout.write(`Total size: ${formatBytes(totalBytes)} (${totalBytes} bytes)\n`);
      if (!files.length) {
        return;
      }
      for (const item of files) {
        const label = item.kind === 'active' ? 'active' : `rotated.${item.index}`;
        ctx.stdout.write(`- ${label} | ${formatBytes(item.sizeBytes)} | ${item.modifiedAtUtc} | ${item.path}\n`);
      }
    });

  logs
    .command('gc')
    .description('Prune rotated action log files by count/age retention')
    .option('--path <path>', 'Action log file override')
    .option('--max-files <n>', 'Maximum total files to retain (active + rotated)')
    .option('--max-age-days <days>', 'Remove rotated files older than this many days')
    .option('--dry-run', 'Preview cleanup without deleting files')
    .option('--format <format>', 'text|json', 'text')
    .action(
      async (
        options: {
          path?: string;
          maxFiles?: string;
          maxAgeDays?: string;
          dryRun?: boolean;
          format?: string;
        },
        command: Command
      ) => {
        const settings = await ctx.resolveSettings();
        const maxFiles = parsePositiveIntegerOption(options.maxFiles, settings.values.logs.maxFiles, 'max-files');
        const maxAgeDays = parsePositiveNumberOption(options.maxAgeDays, undefined, 'max-age-days');
        const maxAgeMs = maxAgeDays === undefined ? undefined : Math.round(maxAgeDays * 24 * 60 * 60 * 1000);

        const before = listCliActionLogFiles(options.path);
        const beforeMap = new Map(before.map((item) => [item.path, item]));
        const result = pruneCliActionLogFiles({
          path: options.path,
          maxFiles,
          maxAgeMs,
          dryRun: options.dryRun === true
        });
        const removedBytes = result.removed.reduce(
          (sum, item) => sum + (beforeMap.get(item)?.sizeBytes ?? 0),
          0
        );

        if (
          resolveTextJsonOutput({
            output: getExplicitGlobalOutput(command),
            format: options.format,
            stdoutIsTTY: ctx.stdoutIsTTY,
            settings
          }) === 'json'
        ) {
          printJson(
            ctx.stdout,
            {
              schemaVersion: 'xyte.cli.action-log.gc.v1',
              path: result.path,
              dryRun: options.dryRun === true,
              maxFiles,
              maxAgeDays,
              removedCount: result.removed.length,
              removedBytes,
              removed: result.removed,
              kept: result.kept
            },
            { strictJson: resolveStrictJson({ settings }) }
          );
          return;
        }

        ctx.stdout.write(`Path: ${result.path}\n`);
        ctx.stdout.write(`Mode: ${options.dryRun === true ? 'dry-run' : 'apply'}\n`);
        ctx.stdout.write(`Removed files: ${result.removed.length}\n`);
        ctx.stdout.write(`Freed: ${formatBytes(removedBytes)} (${removedBytes} bytes)\n`);
        if (result.removed.length) {
          for (const item of result.removed) {
            ctx.stdout.write(`- removed ${item}\n`);
          }
        }
      }
    );

  logs
    .command('view')
    .description('Interactive arrow-key action log viewer')
    .option('--path <path>', 'Action log file override')
    .option('--limit <n>', 'Max number of entries', '250')
    .option('--event <event>', 'Filter by event name')
    .option('--command <text>', 'Filter by command path substring')
    .action(async (options: { path?: string; limit?: string; event?: string; command?: string }) => {
      if (!ctx.isInteractive) {
        throw new Error('Interactive log viewer requires a TTY. Use `xyte-cli logs list` in non-interactive mode.');
      }

      const limit = parsePositiveIntegerOption(options.limit, 250, 'limit');
      const result = readCliActionLog({
        path: options.path,
        limit,
        event: options.event,
        command: options.command
      });

      if (!result.entries.length) {
        ctx.stdout.write(`No action log entries found at ${result.path}\n`);
        return;
      }

      await runActionLogViewer({
        entries: result.entries,
        title: `xyte-cli logs | ${result.path}`
      });
    });
}
