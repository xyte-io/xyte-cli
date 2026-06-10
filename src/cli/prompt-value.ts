import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

import type { OutputStream } from './cli-context';

interface PromptStreams {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export async function promptValue(
  args: {
    question: string;
    initial?: string;
    stdout: OutputStream;
    secret?: boolean;
  } & PromptStreams
): Promise<string> {
  return args.secret ? promptSecret(args) : promptPlain(args);
}

async function promptPlain(args: { question: string; initial?: string } & PromptStreams): Promise<string> {
  const rl = createInterface({
    input: args.input ?? process.stdin,
    output: args.output ?? process.stdout,
    terminal: true
  });
  try {
    const suffix = args.initial ? ` [${args.initial}]` : '';
    const answer = (await rl.question(`${args.question}${suffix}: `)).trim();
    return answer || args.initial || '';
  } finally {
    rl.close();
  }
}

async function promptSecret(args: { question: string; stdout: OutputStream } & PromptStreams): Promise<string> {
  const mutedOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
  const rl = createInterface({
    input: args.input ?? process.stdin,
    output: mutedOutput,
    terminal: true
  });
  try {
    args.stdout.write(`${args.question} (input hidden; paste, then press Enter): `);
    const answer = (await rl.question('')).trim();
    args.stdout.write('\n');
    if (answer) {
      args.stdout.write(`Received ${answer.length} characters.\n`);
    }
    return answer;
  } finally {
    rl.close();
  }
}
