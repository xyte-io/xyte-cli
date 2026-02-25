import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import { createCli } from '../src/cli/index';
import { createCliActionLogger, sanitizeArgvForLog } from '../src/cli/action-logger';
import { readCliActionLog } from '../src/cli/action-log-store';
import { MemorySecretStore } from '../src/secure/secret-store';
import { MemoryProfileStore } from './support/memory-profile-store';

function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

describe('cli action logging', () => {
  it('sanitizes sensitive argv tokens', () => {
    const sanitized = sanitizeArgvForLog([
      'call',
      '--key',
      'abc123',
      '--token=xyz',
      '--tenant',
      'acme',
      '--authorization',
      'Bearer long-secret'
    ]);

    expect(sanitized).toEqual([
      'call',
      '--key',
      '[REDACTED]',
      '--token=[REDACTED]',
      '--tenant',
      'acme',
      '--authorization',
      '[REDACTED]'
    ]);
  });

  it('writes redacted entries and parses logs from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xyte-cli-action-log-'));
    const logPath = join(dir, 'actions.ndjson');

    const logger = createCliActionLogger({
      enabled: true,
      path: logPath,
      argv: ['call', '--key', 'super-secret']
    });
    logger.log('command.start', {
      commandPath: 'xyte-cli call',
      options: {
        key: 'super-secret',
        apiKey: 'super-secret',
        authorization: 'Bearer super-secret-token'
      }
    });
    logger.close();

    appendFileSync(logPath, 'not-json\n', 'utf8');

    const result = readCliActionLog({ path: logPath });
    expect(result.entries.length).toBeGreaterThanOrEqual(2);
    expect(result.parseErrors).toBe(1);

    const start = result.entries.find((entry) => entry.event === 'command.start');
    const startData = asRecord(start?.data);
    const options = asRecord(startData.options);
    expect(options.key).toBe('[REDACTED]');
    expect(options.apiKey).toBe('[REDACTED]');
    expect(options.authorization).toBe('[REDACTED]');

    const sessionStart = result.entries.find((entry) => entry.event === 'session.start');
    const sessionData = asRecord(sessionStart?.data);
    const argv = sessionData.argv as string[];
    expect(argv).toContain('[REDACTED]');

    rmSync(dir, { recursive: true, force: true });
  });

  it('records command lifecycle events when enabled globally', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xyte-cli-lifecycle-log-'));
    const logPath = join(dir, 'lifecycle.ndjson');
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await program.parseAsync([
      'node',
      'xyte-cli',
      '--log-actions',
      '--log-actions-path',
      logPath,
      'tenant',
      'list'
    ]);

    const result = readCliActionLog({ path: logPath });
    expect(result.entries.some((entry) => entry.event === 'command.start')).toBe(true);
    expect(result.entries.some((entry) => entry.event === 'command.complete')).toBe(true);
    expect(result.entries.some((entry) => entry.commandPath === 'xyte-cli tenant list')).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it('supports logs list and blocks logs view without tty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xyte-cli-logs-command-'));
    const logPath = join(dir, 'commands.ndjson');
    const seedLogger = createCliActionLogger({
      enabled: true,
      path: logPath
    });
    seedLogger.log('command.complete', {
      commandPath: 'xyte-cli status',
      durationMs: 42
    });
    seedLogger.close();

    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr, isTTY: false });

    await program.parseAsync(['node', 'xyte-cli', 'logs', 'list', '--path', logPath, '--format', 'json']);
    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const payload = JSON.parse(output) as {
      schemaVersion: string;
      entries: Array<{ event: string }>;
    };
    expect(payload.schemaVersion).toBe('xyte.cli.action-log.v1');
    expect(payload.entries.some((entry) => entry.event === 'command.complete')).toBe(true);

    await expect(program.parseAsync(['node', 'xyte-cli', 'logs', 'view', '--path', logPath])).rejects.toThrow(
      'requires a TTY'
    );

    rmSync(dir, { recursive: true, force: true });
  });
});
