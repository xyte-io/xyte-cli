import { promises as fs } from 'node:fs';

import { CliUserError } from '../contracts/user-error';
import { errorMessage } from '../utils/error-format';
import type { OutputStream, PromptValueFn } from './cli-context';

function createSecretConflictError(cause: string): CliUserError {
  return new CliUserError({
    summary: 'Conflicting API key sources.',
    cause,
    suggestedCommands: ['Use exactly one of --key, --key-file, --key-stdin, or XYTE_CLI_KEY']
  });
}

async function readKeyFileValue(keyFile: string): Promise<string | undefined> {
  try {
    const value = await fs.readFile(keyFile, 'utf8');
    return value.trim() || undefined;
  } catch (error) {
    throw new CliUserError({
      summary: 'Could not read API key file.',
      cause: `${keyFile}: ${errorMessage(error)}`,
      suggestedCommands: [
        'Use --key-file <path> with a readable UTF-8 file.',
        'Use --key-stdin if you prefer piping the key.'
      ]
    });
  }
}

export async function resolveKeyValue(args: {
  key?: string;
  keyFile?: string;
  keyStdin?: boolean;
  envKey?: string;
  allowPrompt?: boolean;
  prompt: PromptValueFn;
  readStdin: () => Promise<string>;
  promptQuestion: string;
  stdout: OutputStream;
}): Promise<string | undefined> {
  const inlineKey = args.key?.trim();
  const keyFile = args.keyFile?.trim();
  const envKey = args.envKey?.trim();

  const explicitSourceCount = [inlineKey, keyFile, args.keyStdin ? 'stdin' : undefined].filter(Boolean).length;
  if (explicitSourceCount > 1) {
    throw createSecretConflictError('Use exactly one of --key, --key-file, or --key-stdin.');
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
