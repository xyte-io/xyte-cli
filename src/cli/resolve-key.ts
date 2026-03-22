import { CliUserError } from '../contracts/user-error';
import type { OutputStream, PromptValueFn } from './cli-context';

function createSecretConflictError(cause: string): CliUserError {
  return new CliUserError({
    summary: 'Conflicting API key sources.',
    cause,
    suggestedCommands: ['Use exactly one of --key, --key-stdin, or XYTE_CLI_KEY']
  });
}

export async function resolveKeyValue(args: {
  key?: string;
  keyStdin?: boolean;
  envKey?: string;
  allowPrompt?: boolean;
  prompt: PromptValueFn;
  readStdin: () => Promise<string>;
  promptQuestion: string;
  stdout: OutputStream;
}): Promise<string | undefined> {
  const inlineKey = args.key?.trim();
  const envKey = args.envKey?.trim();

  if (inlineKey && args.keyStdin) {
    throw createSecretConflictError('Use either --key or --key-stdin, not both.');
  }
  if (inlineKey) {
    return inlineKey;
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
