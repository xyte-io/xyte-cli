import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type InstallChannelKind = 'npm' | 'windows-msi';

export const WINDOWS_MSI_PACKAGE_ID = 'Xyte.XyteCLI';

export interface InstallChannel {
  kind: InstallChannelKind;
}

const DEFAULT_INSTALL_CHANNEL: InstallChannel = {
  kind: 'npm'
};

function parseInstallChannel(payload: unknown): InstallChannel | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  if (record.kind !== 'windows-msi') {
    return undefined;
  }

  // The marker only flips the channel; the winget id is the fixed WINDOWS_MSI_PACKAGE_ID
  // so a planted file cannot point `xyte-cli upgrade` at another package.
  return { kind: 'windows-msi' };
}

function readInstallChannelFile(filePath: string): InstallChannel | undefined {
  try {
    return parseInstallChannel(JSON.parse(readFileSync(filePath, 'utf8')));
  } catch {
    return undefined;
  }
}

export function detectInstallChannel(installRoot: string = path.resolve(__dirname, '..', '..')): InstallChannel {
  if (process.env.XYTE_CLI_INSTALL_CHANNEL?.trim() === 'windows-msi') {
    return { kind: 'windows-msi' };
  }
  if (process.env.XYTE_CLI_INSTALL_CHANNEL?.trim() === 'npm') {
    return DEFAULT_INSTALL_CHANNEL;
  }

  // Only the MSI layout location counts: the MSI writes install-channel.json to the
  // install root, next to dist/ (this file compiles to <root>/dist/utils/). Walking up
  // further would let any repo the CLI runs from plant a marker.
  const candidate = path.join(path.resolve(installRoot), 'install-channel.json');
  if (existsSync(candidate)) {
    const channel = readInstallChannelFile(candidate);
    if (channel) {
      return channel;
    }
  }

  return DEFAULT_INSTALL_CHANNEL;
}
