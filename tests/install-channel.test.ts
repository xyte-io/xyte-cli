import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { detectInstallChannel } from '../src/utils/install-channel';

const previousChannel = process.env.XYTE_CLI_INSTALL_CHANNEL;
const previousChannelFile = process.env.XYTE_CLI_INSTALL_CHANNEL_FILE;

afterEach(() => {
  if (previousChannel === undefined) {
    delete process.env.XYTE_CLI_INSTALL_CHANNEL;
  } else {
    process.env.XYTE_CLI_INSTALL_CHANNEL = previousChannel;
  }
  if (previousChannelFile === undefined) {
    delete process.env.XYTE_CLI_INSTALL_CHANNEL_FILE;
  } else {
    process.env.XYTE_CLI_INSTALL_CHANNEL_FILE = previousChannelFile;
  }
});

describe('install channel detection', () => {
  it('defaults to npm', () => {
    delete process.env.XYTE_CLI_INSTALL_CHANNEL;
    delete process.env.XYTE_CLI_INSTALL_CHANNEL_FILE;

    expect(detectInstallChannel('/tmp/no-channel-here')).toEqual({
      kind: 'npm',
      updateCommand: 'npm install --global @xyteai/cli@latest'
    });
  });

  it('detects Windows MSI channel from install-channel.json', () => {
    delete process.env.XYTE_CLI_INSTALL_CHANNEL;
    delete process.env.XYTE_CLI_INSTALL_CHANNEL_FILE;

    const root = mkdtempSync(join(tmpdir(), 'xyte-install-channel-'));
    const nested = join(root, 'dist', 'utils');
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(root, 'install-channel.json'),
      JSON.stringify({
        kind: 'windows-msi',
        packageId: 'Xyte.XyteCLI',
        updateCommand: 'winget upgrade --id Xyte.XyteCLI --exact'
      })
    );

    expect(detectInstallChannel(nested)).toMatchObject({
      kind: 'windows-msi',
      packageId: 'Xyte.XyteCLI',
      updateCommand: 'winget upgrade --id Xyte.XyteCLI --exact'
    });
  });
});
