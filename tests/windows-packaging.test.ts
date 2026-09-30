import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { findExpectedSha256, generateWingetManifests, parseArgs, validateArgs } from '../scripts/package_windows_msi.mjs';

describe('windows packaging argument parsing', () => {
  it('parses flags and values', () => {
    const args = parseArgs(['--out-dir', '/tmp/out', '--node-version', 'v22.1.0', '--skip-build']);
    expect(args.outDir.endsWith('out')).toBe(true);
    expect(args.nodeVersion).toBe('22.1.0');
    expect(args.skipBuild).toBe(true);
    expect(args.skipMsi).toBe(false);
  });

  it('rejects a value flag with no value', () => {
    expect(() => parseArgs(['--out-dir'])).toThrow('--out-dir requires a value.');
    expect(() => parseArgs(['--node-version', '--skip-msi'])).toThrow('--node-version requires a value.');
  });

  it('rejects unknown arguments', () => {
    expect(() => parseArgs(['--bogus'])).toThrow('Unknown argument: --bogus');
  });

  it('rejects payload skip flags on real MSI builds', () => {
    expect(() => validateArgs(parseArgs(['--skip-node']))).toThrow('--skip-node is only valid with --skip-msi');
    expect(() => validateArgs(parseArgs(['--skip-npm-install']))).toThrow(
      '--skip-npm-install is only valid with --skip-msi'
    );
    expect(() => validateArgs(parseArgs(['--skip-node', '--skip-npm-install', '--skip-msi']))).not.toThrow();
  });
});

describe('windows packaging checksum parsing', () => {
  const shasums = [
    'a'.repeat(64) + '  node-v22.1.0-win-x64.zip',
    'b'.repeat(64) + '  node-v22.1.0-win-x86.zip',
    'not-a-hash  node-v22.1.0-win-arm64.zip',
    ''
  ].join('\n');

  it('finds the checksum for the exact file name', () => {
    expect(findExpectedSha256(shasums, 'node-v22.1.0-win-x64.zip')).toBe('A'.repeat(64));
  });

  it('ignores malformed hash lines', () => {
    expect(findExpectedSha256(shasums, 'node-v22.1.0-win-arm64.zip')).toBeUndefined();
  });

  it('returns undefined when the file is missing', () => {
    expect(findExpectedSha256(shasums, 'node-v99.0.0-win-x64.zip')).toBeUndefined();
  });
});

describe('winget manifests', () => {
  it('declares the MSI UpgradeCode so winget matches MSIs installed outside winget', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'xyte-winget-'));
    const wingetDir = generateWingetManifests({ outDir }, join(outDir, 'missing.msi'));
    const installer = readFileSync(join(wingetDir, 'Xyte.XyteCLI.installer.yaml'), 'utf8');

    expect(installer).toContain("AppsAndFeaturesEntries:\n- UpgradeCode: '{51D2C16F-65D2-4C39-9C6D-49D1D513AF2A}'\n");
  });
});
