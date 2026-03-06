import os from 'node:os';
import path from 'node:path';

export function getXyteConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XYTE_CLI_CONFIG_DIR) {
    return env.XYTE_CLI_CONFIG_DIR;
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'xyte-cli');
  }

  if (process.platform === 'win32') {
    const appData = env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'xyte-cli');
  }

  const xdg = env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(xdg, 'xyte-cli');
}
