import crossSpawn from 'cross-spawn';

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = crossSpawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.stdio ?? 'inherit',
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr
      });
    });

    if (options.input !== undefined && child.stdin) {
      child.stdin.end(options.input);
    }
  });
}

export async function runOrThrow(command, args, label, options = {}) {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) {
    throw new Error(`${label} failed with exit code ${result.code}.`);
  }
  return result;
}

export async function commandExists(command) {
  const result = await runCommand(command, ['--version'], {
    stdio: 'ignore'
  });
  return result.code === 0;
}
