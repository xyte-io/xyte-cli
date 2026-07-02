import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

interface PackagingArgs {
  outDir: string;
  nodeVersion: string;
  skipBuild: boolean;
  skipMsi: boolean;
  skipNode: boolean;
  skipNpmInstall: boolean;
}

interface PackagingModule {
  parseArgs: (argv: string[]) => PackagingArgs;
  validateArgs: (args: PackagingArgs) => void;
  findExpectedSha256: (shasumsText: string, fileName: string) => string | undefined;
}

let packaging: PackagingModule;

beforeAll(async () => {
  const scriptUrl = pathToFileURL(join(__dirname, '..', 'scripts', 'package_windows_msi.mjs')).href;
  packaging = (await import(scriptUrl)) as PackagingModule;
});

describe('windows packaging argument parsing', () => {
  it('parses flags and values', () => {
    const args = packaging.parseArgs(['--out-dir', '/tmp/out', '--node-version', 'v22.1.0', '--skip-build']);
    expect(args.outDir.endsWith('out')).toBe(true);
    expect(args.nodeVersion).toBe('22.1.0');
    expect(args.skipBuild).toBe(true);
    expect(args.skipMsi).toBe(false);
  });

  it('rejects a value flag with no value', () => {
    expect(() => packaging.parseArgs(['--out-dir'])).toThrow('--out-dir requires a value.');
    expect(() => packaging.parseArgs(['--node-version', '--skip-msi'])).toThrow('--node-version requires a value.');
  });

  it('rejects unknown arguments', () => {
    expect(() => packaging.parseArgs(['--bogus'])).toThrow('Unknown argument: --bogus');
  });

  it('rejects payload skip flags on real MSI builds', () => {
    expect(() => packaging.validateArgs(packaging.parseArgs(['--skip-node']))).toThrow(
      '--skip-node is only valid with --skip-msi'
    );
    expect(() => packaging.validateArgs(packaging.parseArgs(['--skip-npm-install']))).toThrow(
      '--skip-npm-install is only valid with --skip-msi'
    );
    expect(() => packaging.validateArgs(packaging.parseArgs(['--skip-node', '--skip-npm-install', '--skip-msi']))).not.toThrow();
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
    expect(packaging.findExpectedSha256(shasums, 'node-v22.1.0-win-x64.zip')).toBe('A'.repeat(64));
  });

  it('ignores malformed hash lines', () => {
    expect(packaging.findExpectedSha256(shasums, 'node-v22.1.0-win-arm64.zip')).toBeUndefined();
  });

  it('returns undefined when the file is missing', () => {
    expect(packaging.findExpectedSha256(shasums, 'node-v99.0.0-win-x64.zip')).toBeUndefined();
  });
});
