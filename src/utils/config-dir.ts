import os from 'node:os';
import path from 'node:path';

export function getXyteConfigDir(): string {
  if (process.env.XYTE_CLI_CONFIG_DIR) {
    return process.env.XYTE_CLI_CONFIG_DIR;
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'xyte-cli');
  }

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'xyte-cli');
  }

  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(xdg, 'xyte-cli');
}
