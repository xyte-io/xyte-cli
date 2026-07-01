import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type InstallChannelKind = 'npm' | 'windows-msi';

export interface InstallChannel {
  kind: InstallChannelKind;
  updateCommand: string;
  packageId?: string;
  releaseUrl?: string;
}

const DEFAULT_INSTALL_CHANNEL: InstallChannel = {
  kind: 'npm',
  updateCommand: 'npm install --global @xyteai/cli@latest'
};

function parseInstallChannel(payload: unknown): InstallChannel | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  if (record.kind !== 'windows-msi') {
    return undefined;
  }

  return {
    kind: 'windows-msi',
    updateCommand:
      typeof record.updateCommand === 'string' && record.updateCommand.trim()
        ? record.updateCommand.trim()
        : 'winget upgrade --id Xyte.XyteCLI --exact',
    packageId: typeof record.packageId === 'string' ? record.packageId : undefined,
    releaseUrl: typeof record.releaseUrl === 'string' ? record.releaseUrl : undefined
  };
}

function readInstallChannelFile(filePath: string): InstallChannel | undefined {
  try {
    return parseInstallChannel(JSON.parse(readFileSync(filePath, 'utf8')));
  } catch {
    return undefined;
  }
}

export function detectInstallChannel(startDir: string = __dirname): InstallChannel {
  const overrideFile = process.env.XYTE_CLI_INSTALL_CHANNEL_FILE?.trim();
  if (overrideFile) {
    const channel = readInstallChannelFile(path.resolve(overrideFile));
    if (channel) {
      return channel;
    }
  }

  if (process.env.XYTE_CLI_INSTALL_CHANNEL?.trim() === 'windows-msi') {
    return {
      kind: 'windows-msi',
      updateCommand: 'winget upgrade --id Xyte.XyteCLI --exact',
      packageId: 'Xyte.XyteCLI'
    };
  }

  let current = path.resolve(startDir);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(current, 'install-channel.json');
    if (existsSync(candidate)) {
      const channel = readInstallChannelFile(candidate);
      if (channel) {
        return channel;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return DEFAULT_INSTALL_CHANNEL;
}
