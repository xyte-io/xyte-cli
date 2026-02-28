import { accessSync, constants, existsSync } from 'node:fs';
import path, { delimiter } from 'node:path';

export function resolveCommandFromPath(command: string, envPath = process.env.PATH ?? ''): string | undefined {
  const pathEntries = envPath.split(delimiter).filter(Boolean);
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .filter(Boolean)
          .map((ext) => ext.toLowerCase())
      : [''];

  for (const entry of pathEntries) {
    for (const ext of extensions) {
      const candidate = process.platform === 'win32' ? path.join(entry, `${command}${ext}`) : path.join(entry, command);
      if (!existsSync(candidate)) {
        continue;
      }
      try {
        accessSync(candidate, constants.X_OK);
      } catch {
        continue;
      }
      return candidate;
    }
  }

  return undefined;
}
