import crossSpawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';

export interface ProcessRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  stdinMode?: 'pipe' | 'ignore';
}

export interface ProcessRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runProcess(command: string, args: string[], options: ProcessRunOptions = {}): Promise<ProcessRunResult> {
  const stdinMode = options.stdinMode ?? 'pipe';

  return await new Promise((resolve, reject) => {
    const child: ChildProcess = crossSpawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [stdinMode, 'pipe', 'pipe'],
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });

    child.on('error', (error: Error) => {
      reject(error);
    });

    child.on('close', (code: number | null) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr
      });
    });

    if (stdinMode === 'pipe' && child.stdin) {
      child.stdin.on('error', (error: Error) => {
        reject(error);
      });
      child.stdin.end(options.input);
    }
  });
}
