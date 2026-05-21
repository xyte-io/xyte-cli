export function getEnvVarCaseInsensitive(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (platform !== 'win32') {
    return env[name];
  }

  const matchingKey = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
  return matchingKey ? env[matchingKey] : undefined;
}

export function getEnvPathKey(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') {
    return 'PATH';
  }

  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path';
}

export function getEnvPathValue(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  return getEnvVarCaseInsensitive(env, 'PATH', platform) ?? '';
}

export function setEnvPathValue(
  env: NodeJS.ProcessEnv,
  value: string,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  if (platform !== 'win32') {
    return {
      ...env,
      PATH: value
    };
  }

  const nextEnv: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(nextEnv)) {
    if (key.toLowerCase() === 'path') {
      delete nextEnv[key];
    }
  }

  nextEnv[getEnvPathKey(env, platform)] = value;
  return nextEnv;
}
