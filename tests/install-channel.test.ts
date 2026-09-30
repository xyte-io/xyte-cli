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
      kind: 'npm'
    });
  });

  it('detects Windows MSI channel from install-channel.json at the install root', () => {
    delete process.env.XYTE_CLI_INSTALL_CHANNEL;
    delete process.env.XYTE_CLI_INSTALL_CHANNEL_FILE;

    const root = mkdtempSync(join(tmpdir(), 'xyte-install-channel-'));
    writeFileSync(join(root, 'install-channel.json'), JSON.stringify({ kind: 'windows-msi', packageId: 'Xyte.XyteCLI' }));

    expect(detectInstallChannel(root)).toEqual({
      kind: 'windows-msi',
      packageId: 'Xyte.XyteCLI'
    });
  });

  it('ignores install-channel.json markers above the install root', () => {
    delete process.env.XYTE_CLI_INSTALL_CHANNEL;
    delete process.env.XYTE_CLI_INSTALL_CHANNEL_FILE;

    const root = mkdtempSync(join(tmpdir(), 'xyte-install-channel-'));
    const nested = join(root, 'node_modules', '@xyteai', 'cli');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, 'install-channel.json'), JSON.stringify({ kind: 'windows-msi', packageId: 'Xyte.XyteCLI' }));

    expect(detectInstallChannel(nested)).toEqual({ kind: 'npm' });
  });

  it('lets XYTE_CLI_INSTALL_CHANNEL=npm override an install-channel.json marker', () => {
    delete process.env.XYTE_CLI_INSTALL_CHANNEL_FILE;
    process.env.XYTE_CLI_INSTALL_CHANNEL = 'npm';

    const root = mkdtempSync(join(tmpdir(), 'xyte-install-channel-'));
    writeFileSync(join(root, 'install-channel.json'), JSON.stringify({ kind: 'windows-msi', packageId: 'Xyte.XyteCLI' }));

    expect(detectInstallChannel(root)).toEqual({ kind: 'npm' });
  });

  it('always uses the fixed winget package id, whatever the marker says', () => {
    delete process.env.XYTE_CLI_INSTALL_CHANNEL;
    delete process.env.XYTE_CLI_INSTALL_CHANNEL_FILE;

    const root = mkdtempSync(join(tmpdir(), 'xyte-install-channel-'));
    writeFileSync(join(root, 'install-channel.json'), JSON.stringify({ kind: 'windows-msi', packageId: 'Evil.Package' }));

    expect(detectInstallChannel(root)).toEqual({
      kind: 'windows-msi',
      packageId: 'Xyte.XyteCLI'
    });
  });
});
