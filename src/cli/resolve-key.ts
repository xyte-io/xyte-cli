import { exec, type ExecException } from 'node:child_process';
import { promises as fs } from 'node:fs';

import { CliUserError } from '../contracts/user-error';
import { errorMessage } from '../utils/error-format';
import type { OutputStream, PromptValueFn } from './cli-context';

export interface KeyCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunKeyCommandFn = (command: string) => Promise<KeyCommandResult>;

function createSecretConflictError(detail: string): CliUserError {
  return new CliUserError({
    summary: 'Conflicting API key sources.',
    detail,
    suggestedCommands: ['Use exactly one of --key, --key-file, --key-stdin, --key-command, or XYTE_CLI_KEY']
  });
}

async function readKeyFileValue(keyFile: string): Promise<string | undefined> {
  try {
    const value = await fs.readFile(keyFile, 'utf8');
    return value.trim() || undefined;
  } catch (error) {
    throw new CliUserError({
      summary: 'Could not read API key file.',
      detail: `${keyFile}: ${errorMessage(error)}`,
      suggestedCommands: [
        'Use --key-file <path> with a readable UTF-8 file.',
        'Use --key-stdin if you prefer piping the key.'
      ]
    });
  }
}

export const runKeyCommand: RunKeyCommandFn = (command) =>
  new Promise((resolve) => {
    exec(command, { windowsHide: true }, (error: ExecException | null, stdout: string, stderr: string) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });

async function resolveKeyCommandValue(
  command: string,
  runCommand: RunKeyCommandFn
): Promise<string | undefined> {
  let result: KeyCommandResult;
  try {
    result = await runCommand(command);
  } catch (error) {
    throw new CliUserError({
      summary: 'API key command failed to start.',
      detail: errorMessage(error),
      suggestedCommands: ['Verify the --key-command executable is on PATH and runs non-interactively.']
    });
  }
  if (result.code !== 0) {
    const stderr = result.stderr.trim();
    throw new CliUserError({
      summary: 'API key command exited with a non-zero status.',
      detail: stderr ? `exit ${result.code}: ${stderr}` : `exit ${result.code}`,
      suggestedCommands: [
        'Run the --key-command manually to verify it prints the key on stdout.',
        'Ensure the secret manager session is authenticated before running xyte-cli.'
      ]
    });
  }
  return result.stdout.trim() || undefined;
}

export async function resolveKeyValue(args: {
  key?: string;
  keyFile?: string;
  keyStdin?: boolean;
  keyCommand?: string;
  envKey?: string;
  allowPrompt?: boolean;
  prompt: PromptValueFn;
  readStdin: () => Promise<string>;
  runCommand?: RunKeyCommandFn;
  promptQuestion: string;
  stdout: OutputStream;
}): Promise<string | undefined> {
  const inlineKey = args.key?.trim();
  const keyFile = args.keyFile?.trim();
  const keyCommand = args.keyCommand?.trim();
  const envKey = args.envKey?.trim();

  const explicitSourceCount = [
    inlineKey,
    keyFile,
    args.keyStdin ? 'stdin' : undefined,
    keyCommand
  ].filter(Boolean).length;
  if (explicitSourceCount > 1) {
    throw createSecretConflictError('Use exactly one of --key, --key-file, --key-stdin, or --key-command.');
  }
  if (inlineKey) {
    return inlineKey;
  }
  if (keyFile) {
    return await readKeyFileValue(keyFile);
  }
  if (args.keyStdin) {
    const stdinValue = (await args.readStdin()).trim();
    return stdinValue || undefined;
  }
  if (keyCommand) {
    return await resolveKeyCommandValue(keyCommand, args.runCommand ?? runKeyCommand);
  }
  if (envKey) {
    return envKey;
  }
  if (args.allowPrompt) {
    const prompted = await args.prompt({
      question: args.promptQuestion,
      stdout: args.stdout,
      secret: true
    });
    return prompted.trim() || undefined;
  }
  return undefined;
}
