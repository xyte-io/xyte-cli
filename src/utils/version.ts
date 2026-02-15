import { readFileSync } from 'node:fs';
import path from 'node:path';

let cachedVersion: string | undefined;

export function getCliVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }

  try {
    const packageJsonPath = path.resolve(__dirname, '../../package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
    if (typeof packageJson.version === 'string' && packageJson.version.trim()) {
      cachedVersion = packageJson.version;
      return cachedVersion;
    }
  } catch {
    // Fall through to a safe default version string.
  }

  cachedVersion = '0.0.0';
  return cachedVersion;
}
