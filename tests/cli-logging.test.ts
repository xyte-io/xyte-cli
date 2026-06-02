import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCli, runCli } from '../src/cli/index';
import { createCliActionLogger, listCliActionLogFiles, pruneCliActionLogFiles, sanitizeArgvForLog } from '../src/cli/action-logger';
import { readCliActionLog } from '../src/cli/action-log-store';
import { MemorySecretStore } from '../src/secure/secret-store';
import { MemoryProfileStore } from './support/memory-profile-store';

function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

function nodeEvalCommand(script: string): string {
  return `"${process.execPath}" -e ${JSON.stringify(script)}`;
}

describe('cli action logging', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

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
      commandPath: 'xyte-cli api call',
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

  it('rotates files and keeps secure file permissions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xyte-cli-rotation-log-'));
    const logPath = join(dir, 'actions.ndjson');
    const logger = createCliActionLogger({
      enabled: true,
      path: logPath,
      maxFileBytes: 700,
      maxFiles: 3
    });

    for (let index = 0; index < 80; index += 1) {
      logger.log('test.rotation', {
        commandPath: 'xyte-cli test',
        message: 'x'.repeat(120),
        index
      });
    }
    logger.close();

    const files = listCliActionLogFiles(logPath);
    expect(files.length).toBeLessThanOrEqual(3);
    expect(files.some((file) => file.kind === 'rotated')).toBe(true);

    const mode = statSync(logPath).mode & 0o777;
    if (process.platform === 'win32') {
      expect(mode).toBeGreaterThan(0);
    } else {
      expect(mode).toBe(0o600);
    }

    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps only an active log file when maxFiles is 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xyte-cli-maxfiles1-log-'));
    const logPath = join(dir, 'actions.ndjson');
    const logger = createCliActionLogger({
      enabled: true,
      path: logPath,
      maxFileBytes: 700,
      maxFiles: 1
    });

    for (let index = 0; index < 80; index += 1) {
      logger.log('test.maxfiles1', {
        commandPath: 'xyte-cli test',
        message: 'x'.repeat(120),
        index
      });
    }
    logger.close();

    const files = listCliActionLogFiles(logPath);
    expect(files.length).toBe(1);
    expect(files[0]?.kind).toBe('active');
    expect(files.some((file) => file.kind === 'rotated')).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });

  it('returns filtered tail entries from large log files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xyte-cli-tail-log-'));
    const logPath = join(dir, 'actions.ndjson');
    const logger = createCliActionLogger({
      enabled: true,
      path: logPath,
      maxFileBytes: 50 * 1024 * 1024,
      maxFiles: 2
    });

    for (let index = 1; index <= 2000; index += 1) {
      logger.log('test.tail', {
        commandPath: 'xyte-cli tail',
        seq: index
      });
    }
    logger.close();

    const result = readCliActionLog({
      path: logPath,
      event: 'test.tail',
      limit: 20
    });
    const tailSeq = result.entries.map((entry) => Number(asRecord(entry.data).seq));
    expect(tailSeq.length).toBe(20);
    expect(tailSeq[0]).toBe(1981);
    expect(tailSeq[tailSeq.length - 1]).toBe(2000);

    rmSync(dir, { recursive: true, force: true });
  });

  it('filters action log entries by session id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xyte-cli-session-log-'));
    const logPath = join(dir, 'actions.ndjson');
    const first = createCliActionLogger({ enabled: true, path: logPath, sessionId: 'session-a' });
    first.log('test.session', { commandPath: 'xyte-cli a' });
    first.close();
    const second = createCliActionLogger({ enabled: true, path: logPath, sessionId: 'session-b' });
    second.log('test.session', { commandPath: 'xyte-cli b' });
    second.close();

    const result = readCliActionLog({ path: logPath, sessionId: 'session-b' });
    expect(result.entries.every((entry) => entry.sessionId === 'session-b')).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it('shows one action log entry by exact entry ref and request id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xyte-cli-show-log-'));
    const logPath = join(dir, 'actions.ndjson');
    const logger = createCliActionLogger({ enabled: true, path: logPath, sessionId: 'session-a' });
    logger.log('api.call.complete', { commandPath: 'xyte-cli api call', requestId: 'req-1' });
    logger.close();
    const result = readCliActionLog({ path: logPath, event: 'api.call.complete', limit: 1 });
    const entry = result.entries[0];
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    let program = createCli({ profileStore, secretStore, stdout, stderr });
    await program.parseAsync([
      'node',
      'xyte-cli',
      'logs',
      'show',
      '--path',
      logPath,
      '--entry',
      `${entry.sessionId}:${entry.seq}`,
      '--format',
      'json'
    ]);
    let parsed = JSON.parse(stdout.write.mock.calls.map((call) => String(call[0])).join(''));
    expect(parsed.entry.event).toBe('api.call.complete');

    stdout.write.mockClear();
    program = createCli({ profileStore, secretStore, stdout, stderr });
    await program.parseAsync(['node', 'xyte-cli', 'logs', 'show', '--path', logPath, '--request-id', 'req-1']);
    const text = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    expect(text).toContain('api.call.complete');
    expect(text).toContain('"requestId": "req-1"');

    rmSync(dir, { recursive: true, force: true });
  });

  it('honors global --output json for logs list and show unless local --format is explicit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xyte-cli-logs-output-'));
    const logPath = join(dir, 'actions.ndjson');
    const logger = createCliActionLogger({ enabled: true, path: logPath, sessionId: 'session-output' });
    logger.log('api.call.complete', { commandPath: 'xyte-cli api call', requestId: 'req-output' });
    logger.close();
    const result = readCliActionLog({ path: logPath, event: 'api.call.complete', limit: 1 });
    const entry = result.entries[0];
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    let program = createCli({ profileStore, secretStore, stdout, stderr });
    await program.parseAsync(['node', 'xyte-cli', 'logs', 'list', '--path', logPath, '--output', 'json']);
    const listPayload = JSON.parse(stdout.write.mock.calls.map((call) => String(call[0])).join(''));
    expect(listPayload.schemaVersion).toBe('xyte.cli.action-log.v1');
    expect(listPayload.entries.some((item: { event: string }) => item.event === 'api.call.complete')).toBe(true);

    stdout.write.mockClear();
    program = createCli({ profileStore, secretStore, stdout, stderr });
    await program.parseAsync([
      'node',
      'xyte-cli',
      'logs',
      'show',
      '--path',
      logPath,
      '--entry',
      `${entry.sessionId}:${entry.seq}`,
      '--output',
      'json'
    ]);
    const showPayload = JSON.parse(stdout.write.mock.calls.map((call) => String(call[0])).join(''));
    expect(showPayload.schemaVersion).toBe('xyte.cli.action-log.entry.v1');
    expect(showPayload.entry.event).toBe('api.call.complete');

    stdout.write.mockClear();
    program = createCli({ profileStore, secretStore, stdout, stderr });
    await program.parseAsync([
      'node',
      'xyte-cli',
      'logs',
      'show',
      '--path',
      logPath,
      '--entry',
      `${entry.sessionId}:${entry.seq}`,
      '--output',
      'json',
      '--format',
      'text'
    ]);
    const text = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    expect(text).toContain('api.call.complete');
    expect(() => JSON.parse(text)).toThrow();

    rmSync(dir, { recursive: true, force: true });
  });

  it('finds exact logs show entries older than the bounded list tail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xyte-cli-show-old-log-'));
    const logPath = join(dir, 'actions.ndjson');
    const logger = createCliActionLogger({
      enabled: true,
      path: logPath,
      sessionId: 'session-old',
      maxFileBytes: 50 * 1024 * 1024
    });
    logger.log('api.call.complete', { commandPath: 'xyte-cli api call', requestId: 'req-old' });
    for (let index = 0; index < 5_005; index += 1) {
      logger.log('test.filler', { commandPath: 'xyte-cli filler', index });
    }
    logger.close();
    const targetSeq = 2;
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await program.parseAsync([
      'node',
      'xyte-cli',
      'logs',
      'show',
      '--path',
      logPath,
      '--entry',
      `session-old:${targetSeq}`,
      '--output',
      'json'
    ]);

    const payload = JSON.parse(stdout.write.mock.calls.map((call) => String(call[0])).join(''));
    expect(payload.entry.event).toBe('api.call.complete');
    expect(payload.entry.data.requestId).toBe('req-old');

    rmSync(dir, { recursive: true, force: true });
  });

  it('fails logs show when request id lookup is missing or ambiguous', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xyte-cli-show-log-fail-'));
    const logPath = join(dir, 'actions.ndjson');
    const logger = createCliActionLogger({ enabled: true, path: logPath });
    logger.log('api.call.start', { requestId: 'req-1' });
    logger.log('api.call.complete', { requestId: 'req-1' });
    logger.close();
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    const missingProgram = createCli({ profileStore, secretStore, stdout, stderr });
    await expect(
      missingProgram.parseAsync(['node', 'xyte-cli', 'logs', 'show', '--path', logPath, '--request-id', 'missing'])
    ).rejects.toThrow('No matching action log entry found');

    const ambiguousProgram = createCli({ profileStore, secretStore, stdout, stderr });
    await expect(
      ambiguousProgram.parseAsync(['node', 'xyte-cli', 'logs', 'show', '--path', logPath, '--request-id', 'req-1'])
    ).rejects.toThrow('Multiple action log entries matched');

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
      'config',
      'tenant',
      'list'
    ]);

    const result = readCliActionLog({ path: logPath });
    expect(result.entries.some((entry) => entry.event === 'command.start')).toBe(true);
    expect(result.entries.some((entry) => entry.event === 'command.complete')).toBe(true);
    expect(result.entries.some((entry) => entry.commandPath === 'xyte-cli config tenant list')).toBe(true);
    const commandStart = result.entries.find((entry) => entry.event === 'command.start');
    const commandStartData = asRecord(commandStart?.data);
    expect(commandStartData.commandPath).toBe('xyte-cli config tenant list');
    expect(commandStartData.options).toBeUndefined();
    expect(commandStartData.argv).toBeUndefined();

    const verbosePath = join(dir, 'verbose.ndjson');
    const verboseProgram = createCli({ profileStore, secretStore, stdout, stderr });
    await verboseProgram.parseAsync([
      'node',
      'xyte-cli',
      '--log-actions',
      '--log-actions-verbose',
      '--log-actions-path',
      verbosePath,
      'config',
      'tenant',
      'list'
    ]);
    const verboseResult = readCliActionLog({ path: verbosePath, event: 'command.start', limit: 1 });
    const verboseData = asRecord(verboseResult.entries[0]?.data);
    expect(Array.isArray(verboseData.argv)).toBe(true);
    expect(verboseData.options).toBeDefined();

    rmSync(dir, { recursive: true, force: true });
  });

  it('does not log API keys read from stdin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xyte-cli-stdin-log-'));
    const logPath = join(dir, 'stdin.ndjson');
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({
      profileStore,
      secretStore,
      stdout,
      stderr,
      readStdinValue: vi.fn().mockResolvedValue('super-secret-key')
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: 'org-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    );

    await program.parseAsync([
      'node',
      'xyte-cli',
      '--log-actions',
      '--log-actions-verbose',
      '--log-actions-path',
      logPath,
      'setup',
      'run',
      '--non-interactive',
      '--tenant',
      'acme',
      '--key-stdin'
    ]);

    const rawLog = readFileSync(logPath, 'utf8');
    expect(rawLog).not.toContain('super-secret-key');

    const result = readCliActionLog({ path: logPath, event: 'command.start', limit: 1 });
    const data = asRecord(result.entries[0]?.data);
    const argv = (data.argv ?? []) as string[];
    expect(argv).toContain('--key-stdin');
    expect(argv).not.toContain('super-secret-key');

    rmSync(dir, { recursive: true, force: true });
  });

  it('does not log API keys read from files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xyte-cli-key-file-log-'));
    const logPath = join(dir, 'key-file.ndjson');
    const keyPath = join(dir, 'org.key');
    writeFileSync(keyPath, 'super-secret-key\n');
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: 'org-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    );

    await program.parseAsync([
      'node',
      'xyte-cli',
      '--log-actions',
      '--log-actions-verbose',
      '--log-actions-path',
      logPath,
      'setup',
      'run',
      '--non-interactive',
      '--tenant',
      'acme',
      '--key-file',
      keyPath
    ]);

    const rawLog = readFileSync(logPath, 'utf8');
    expect(rawLog).not.toContain('super-secret-key');

    const result = readCliActionLog({ path: logPath, event: 'command.start', limit: 1 });
    const data = asRecord(result.entries[0]?.data);
    const argv = (data.argv ?? []) as string[];
    expect(argv).toContain('--key-file');
    expect(argv).toContain(keyPath);
    expect(argv).not.toContain('super-secret-key');

    rmSync(dir, { recursive: true, force: true });
  });

  it('redacts the --key-command argument from action logs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xyte-cli-key-command-log-'));
    const logPath = join(dir, 'key-command.ndjson');
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: 'org-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    );

    const keyCommand = nodeEvalCommand("process.stdout.write('super-secret-key')");

    await program.parseAsync([
      'node',
      'xyte-cli',
      '--log-actions',
      '--log-actions-verbose',
      '--log-actions-path',
      logPath,
      'setup',
      'run',
      '--non-interactive',
      '--tenant',
      'acme',
      '--key-command',
      keyCommand
    ]);

    const rawLog = readFileSync(logPath, 'utf8');
    expect(rawLog).not.toContain('super-secret-key');
    expect(rawLog).not.toContain(keyCommand);

    const result = readCliActionLog({ path: logPath, event: 'command.start', limit: 1 });
    const data = asRecord(result.entries[0]?.data);
    const argv = (data.argv ?? []) as string[];
    expect(argv).toContain('--key-command');
    expect(argv).not.toContain(keyCommand);
    expect(argv).toContain('[REDACTED]');

    rmSync(dir, { recursive: true, force: true });
  });

  it('does not log stderr from failed --key-command executions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xyte-cli-key-command-error-log-'));
    const logPath = join(dir, 'key-command-error.ndjson');
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: 'org-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    );

    await expect(
      runCli(
        [
          'node',
          'xyte-cli',
          '--log-actions',
          '--log-actions-verbose',
          '--log-actions-path',
          logPath,
          'setup',
          'run',
          '--non-interactive',
          '--tenant',
          'acme',
          '--key-command',
          nodeEvalCommand("process.stderr.write('super-secret-key'); process.exit(7)")
        ],
        { profileStore, secretStore, stdout, stderr }
      )
    ).rejects.toThrow('API key command exited with a non-zero status');

    const rawLog = readFileSync(logPath, 'utf8');
    expect(rawLog).not.toContain('super-secret-key');

    const result = readCliActionLog({ path: logPath, event: 'command.error', limit: 1 });
    const data = asRecord(result.entries[0]?.data);
    const error = asRecord(data.error);
    expect(error.cause).toBe('exit 7');

    rmSync(dir, { recursive: true, force: true });
  });

  it('does not log API keys read from stdin for config key add', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xyte-cli-key-add-log-'));
    const logPath = join(dir, 'key-add.ndjson');
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({
      profileStore,
      secretStore,
      stdout,
      stderr,
      readStdinValue: vi.fn().mockResolvedValue('super-secret-key')
    });

    await program.parseAsync([
      'node',
      'xyte-cli',
      '--log-actions',
      '--log-actions-verbose',
      '--log-actions-path',
      logPath,
      'config',
      'key',
      'add',
      '--tenant',
      'acme',
      '--provider',
      'xyte-org',
      '--name',
      'primary',
      '--key-stdin'
    ]);

    const rawLog = readFileSync(logPath, 'utf8');
    expect(rawLog).not.toContain('super-secret-key');

    const result = readCliActionLog({ path: logPath, event: 'command.start', limit: 1 });
    const data = asRecord(result.entries[0]?.data);
    const argv = (data.argv ?? []) as string[];
    expect(argv).toContain('--key-stdin');
    expect(argv).not.toContain('super-secret-key');

    rmSync(dir, { recursive: true, force: true });
  });

  it('does not log API keys read from stdin for config key update', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xyte-cli-key-update-log-'));
    const logPath = join(dir, 'key-update.ndjson');
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    await profileStore.upsertTenant({ id: 'acme' });
    const slot = await profileStore.addKeySlot('acme', 'xyte-org', {
      
      name: 'primary',
      fingerprint: 'old-fingerprint'
    });
    await secretStore.setSlotSecret('acme', 'xyte-org', slot.slotId, 'old-key');

    const program = createCli({
      profileStore,
      secretStore,
      stdout,
      stderr,
      readStdinValue: vi.fn().mockResolvedValue('super-secret-key')
    });

    await program.parseAsync([
      'node',
      'xyte-cli',
      '--log-actions',
      '--log-actions-verbose',
      '--log-actions-path',
      logPath,
      'config',
      'key',
      'update',
      '--tenant',
      'acme',
      '--provider',
      'xyte-org',
      '--slot',
      slot.slotId,
      '--key-stdin'
    ]);

    const rawLog = readFileSync(logPath, 'utf8');
    expect(rawLog).not.toContain('super-secret-key');

    const result = readCliActionLog({ path: logPath, event: 'command.start', limit: 1 });
    const data = asRecord(result.entries[0]?.data);
    const argv = (data.argv ?? []) as string[];
    expect(argv).toContain('--key-stdin');
    expect(argv).not.toContain('super-secret-key');

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

  it('reports stats and applies log gc retention', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xyte-cli-gc-log-'));
    const logPath = join(dir, 'actions.ndjson');
    const seedLogger = createCliActionLogger({
      enabled: true,
      path: logPath,
      maxFileBytes: 700,
      maxFiles: 6
    });
    for (let index = 0; index < 120; index += 1) {
      seedLogger.log('test.gc', {
        commandPath: 'xyte-cli status',
        message: 'x'.repeat(120),
        index
      });
    }
    seedLogger.close();

    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr, isTTY: false });

    await program.parseAsync(['node', 'xyte-cli', 'logs', 'stats', '--path', logPath, '--format', 'json']);
    const statsOutput = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const statsPayload = JSON.parse(statsOutput) as { fileCount: number; totalBytes: number };
    expect(statsPayload.fileCount).toBeGreaterThan(1);
    expect(statsPayload.totalBytes).toBeGreaterThan(0);

    stdout.write.mockClear();
    await program.parseAsync([
      'node',
      'xyte-cli',
      'logs',
      'gc',
      '--path',
      logPath,
      '--max-files',
      '2',
      '--format',
      'json'
    ]);
    const gcOutput = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const gcPayload = JSON.parse(gcOutput) as { removedCount: number; kept: string[] };
    expect(gcPayload.removedCount).toBeGreaterThan(0);
    expect(gcPayload.kept.length).toBeLessThanOrEqual(2);

    const filesAfter = listCliActionLogFiles(logPath);
    expect(filesAfter.length).toBeLessThanOrEqual(2);

    rmSync(dir, { recursive: true, force: true });
  });

  it('pruneCliActionLogFiles removes rotated files older than maxAgeMs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xyte-cli-age-prune-'));
    const logPath = join(dir, 'actions.ndjson');

    // Write enough data to trigger rotation
    const seedLogger = createCliActionLogger({
      enabled: true,
      path: logPath,
      maxFileBytes: 200,
      maxFiles: 10
    });
    for (let i = 0; i < 30; i += 1) {
      seedLogger.log('test.age', { commandPath: 'x', msg: 'x'.repeat(50), i });
    }
    seedLogger.close();

    const filesBefore = listCliActionLogFiles(logPath);
    const rotatedBefore = filesBefore.filter((f) => f.kind === 'rotated');
    expect(rotatedBefore.length).toBeGreaterThan(0);

    // Mock Date.now() to return a far-future timestamp so all files appear old
    const farFuture = Date.now() + 1_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(farFuture);

    const result = pruneCliActionLogFiles({ path: logPath, maxAgeMs: 1, maxFiles: 100, dryRun: true });
    expect(result.removed.length).toBeGreaterThan(0);

    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });
});
