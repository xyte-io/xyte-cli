#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOrThrow } from './run_command.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const upgradeCode = '51D2C16F-65D2-4C39-9C6D-49D1D513AF2A';
const wixEulaId = 'wix7';

function parseArgs(argv) {
  const args = {
    outDir: join(repoRoot, 'artifacts', 'windows-installer'),
    nodeVersion: process.versions.node,
    skipBuild: false,
    skipMsi: false,
    skipNode: false,
    skipNpmInstall: false
  };
  const readValue = (index, flag) => {
    const value = argv[index];
    if (!value || value.startsWith('--')) {
      throw new Error(`${flag} requires a value.`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out-dir') {
      i += 1;
      args.outDir = resolve(readValue(i, arg));
    } else if (arg === '--node-version') {
      i += 1;
      args.nodeVersion = readValue(i, arg).replace(/^v/, '');
    } else if (arg === '--skip-build') args.skipBuild = true;
    else if (arg === '--skip-msi') args.skipMsi = true;
    else if (arg === '--skip-node') args.skipNode = true;
    else if (arg === '--skip-npm-install') args.skipNpmInstall = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function validateArgs(args) {
  if (!args.skipMsi && args.skipNode) {
    throw new Error('--skip-node is only valid with --skip-msi; real MSI builds must include the bundled Node runtime.');
  }
  if (!args.skipMsi && args.skipNpmInstall) {
    throw new Error('--skip-npm-install is only valid with --skip-msi; real MSI builds must include production dependencies.');
  }
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function windowsPath(value) {
  return value.split('/').join('\\');
}

function windowsDirname(value) {
  const index = value.lastIndexOf('\\');
  return index === -1 ? '.' : value.slice(0, index);
}

function stableId(prefix, value) {
  const hash = createHash('sha1').update(value).digest('hex').slice(0, 16);
  return `${prefix}_${hash}`;
}

function listFiles(root) {
  const results = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }
  walk(root);
  return results.sort();
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex').toUpperCase();
}

function findExpectedSha256(shasumsText, fileName) {
  for (const line of shasumsText.split(/\r?\n/)) {
    const [hash, name] = line.trim().split(/\s+/, 2);
    if (name === fileName && /^[a-fA-F0-9]{64}$/.test(hash)) {
      return hash.toUpperCase();
    }
  }
  return undefined;
}

function manifestRelativePath(outDir, filePath) {
  return relative(outDir, filePath).split('\\').join('/');
}

function ensureBuilt() {
  if (!existsSync(join(repoRoot, 'dist', 'bin', 'xyte-cli.js'))) {
    throw new Error('dist/bin/xyte-cli.js is missing. Run npm run build first or omit --skip-build.');
  }
}

function ensureMsiBuildSupported() {
  if (process.platform !== 'win32') {
    throw new Error('Building a Windows MSI with WiX is supported only on Windows. Re-run on Windows or pass --skip-msi for metadata-only packaging.');
  }
}

async function downloadNode(args, payloadDir) {
  if (args.skipNode) {
    writeFileSync(join(payloadDir, 'node.exe.placeholder'), 'Node runtime omitted by --skip-node.\n');
    return;
  }

  const cacheDir = join(args.outDir, 'cache');
  mkdirSync(cacheDir, { recursive: true });
  const nodeBase = `node-v${args.nodeVersion}-win-x64`;
  const zipPath = join(cacheDir, `${nodeBase}.zip`);
  const nodeUrl = `https://nodejs.org/dist/v${args.nodeVersion}/${nodeBase}.zip`;
  const shasumsPath = join(cacheDir, `node-v${args.nodeVersion}-SHASUMS256.txt`);
  const shasumsUrl = `https://nodejs.org/dist/v${args.nodeVersion}/SHASUMS256.txt`;

  if (!existsSync(zipPath)) {
    await runOrThrow(
      process.platform === 'win32' ? 'curl.exe' : 'curl',
      ['--fail', '--location', '--retry', '3', '--connect-timeout', '20', '--max-time', '300', '--output', zipPath, nodeUrl],
      'Download Node.js Windows runtime'
    );
  }
  if (!existsSync(shasumsPath)) {
    await runOrThrow(
      process.platform === 'win32' ? 'curl.exe' : 'curl',
      ['--fail', '--location', '--retry', '3', '--connect-timeout', '20', '--max-time', '60', '--output', shasumsPath, shasumsUrl],
      'Download Node.js runtime checksums'
    );
  }

  const expectedSha256 = findExpectedSha256(readFileSync(shasumsPath, 'utf8'), `${nodeBase}.zip`);
  if (!expectedSha256) {
    throw new Error(`Could not find checksum for ${nodeBase}.zip in ${shasumsPath}.`);
  }
  const actualSha256 = sha256File(zipPath);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Node.js runtime checksum mismatch for ${nodeBase}.zip: expected ${expectedSha256}, got ${actualSha256}.`);
  }

  const extractDir = join(cacheDir, nodeBase);
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });

  if (process.platform === 'win32') {
    await runOrThrow(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`],
      'Extract Node.js Windows runtime'
    );
  } else {
    await runOrThrow('unzip', ['-q', zipPath, '-d', extractDir], 'Extract Node.js Windows runtime');
  }

  const sourceRoot = join(extractDir, nodeBase);
  cpSync(join(sourceRoot, 'node.exe'), join(payloadDir, 'node.exe'));
  cpSync(join(sourceRoot, 'LICENSE'), join(payloadDir, 'node-LICENSE'));
  cpSync(join(sourceRoot, 'README.md'), join(payloadDir, 'node-README.md'));
}

async function installProductionDependencies(args, payloadDir) {
  if (args.skipNpmInstall) {
    writeFileSync(join(payloadDir, 'node_modules.placeholder'), 'Production dependencies omitted by --skip-npm-install.\n');
    return;
  }

  cpSync(join(repoRoot, 'package.json'), join(payloadDir, 'package.json'));
  cpSync(join(repoRoot, 'package-lock.json'), join(payloadDir, 'package-lock.json'));
  await runOrThrow(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['ci', '--omit=dev', '--ignore-scripts'],
    'Install production dependencies for Windows payload',
    { cwd: payloadDir }
  );
}

function copyPayloadFiles(payloadDir) {
  cpSync(join(repoRoot, 'dist'), join(payloadDir, 'dist'), { recursive: true });
  cpSync(join(repoRoot, 'skills'), join(payloadDir, 'skills'), { recursive: true });
  mkdirSync(join(payloadDir, 'docs'), { recursive: true });
  cpSync(join(repoRoot, 'docs', 'schemas'), join(payloadDir, 'docs', 'schemas'), { recursive: true });
  cpSync(join(repoRoot, 'README.md'), join(payloadDir, 'README.md'));

  mkdirSync(join(payloadDir, 'scripts'), { recursive: true });
  cpSync(
    join(repoRoot, 'packaging', 'windows', 'scripts', 'configure-xyte-cli.ps1'),
    join(payloadDir, 'scripts', 'configure-xyte-cli.ps1')
  );

  writeFileSync(
    join(payloadDir, 'xyte-cli.cmd'),
    '@echo off\r\nsetlocal\r\nset "XYTE_CLI_INSTALL_ROOT=%~dp0"\r\n"%XYTE_CLI_INSTALL_ROOT%node.exe" "%XYTE_CLI_INSTALL_ROOT%dist\\bin\\xyte-cli.js" %*\r\n',
    'utf8'
  );

  writeFileSync(
    join(payloadDir, 'install-channel.json'),
    `${JSON.stringify(
      {
        kind: 'windows-msi',
        packageId: 'Xyte.XyteCLI',
        updateCommand: 'winget upgrade --id Xyte.XyteCLI --exact',
        releaseUrl: 'https://github.com/xyte-io/xyte-cli/releases/latest'
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

function generateWxs(payloadDir, wxsPath) {
  const files = listFiles(payloadDir);
  const dirs = new Map();
  const children = new Map();
  const componentsByDir = new Map();
  const featureRefs = [];

  for (const filePath of files) {
    const rel = windowsPath(relative(payloadDir, filePath));
    const relDir = windowsDirname(rel);
    if (relDir !== '.') {
      const parts = relDir.split('\\');
      let current = '';
      for (const part of parts) {
        current = current ? `${current}\\${part}` : part;
        if (!dirs.has(current)) {
          const parent = current.includes('\\') ? current.slice(0, current.lastIndexOf('\\')) : '';
          dirs.set(current, {
            id: stableId('Dir', current),
            name: part,
            parent
          });
          const siblingList = children.get(parent) ?? [];
          siblingList.push(current);
          children.set(parent, siblingList);
        }
      }
    }

    const componentId = stableId('Cmp', rel);
    const fileId = stableId('File', rel);
    const component =
      `          <Component Id="${componentId}" Guid="*">\n` +
      `            <File Id="${fileId}" Source="${xmlEscape(filePath)}" KeyPath="yes" />\n` +
      `          </Component>`;
    const componentList = componentsByDir.get(relDir) ?? [];
    componentList.push(component);
    componentsByDir.set(relDir, componentList);
    featureRefs.push(`      <ComponentRef Id="${componentId}" />`);
  }

  function renderComponents(relDir, indent) {
    return (componentsByDir.get(relDir) ?? []).map((component) =>
      component
        .split('\n')
        .map((line) => `${indent}${line.trimStart()}`)
        .join('\n')
    );
  }

  function renderDirectories(parent, indent) {
    const lines = [];
    for (const relDir of (children.get(parent) ?? []).sort()) {
      const dir = dirs.get(relDir);
      lines.push(`${indent}<Directory Id="${dir.id}" Name="${xmlEscape(dir.name)}">`);
      lines.push(...renderComponents(relDir, `${indent}  `));
      lines.push(...renderDirectories(relDir, `${indent}  `));
      lines.push(`${indent}</Directory>`);
    }
    return lines;
  }
  const directoryLines = renderDirectories('', '        ');
  const rootComponents = renderComponents('.', '        ');

  const template = readFileSync(join(repoRoot, 'packaging', 'windows', 'Product.wxs.template'), 'utf8');
  const wxs = template
    .replaceAll('{{VERSION}}', packageJson.version)
    .replaceAll('{{UPGRADE_CODE}}', upgradeCode)
    .replaceAll('{{DIRECTORIES}}', directoryLines.join('\n'))
    .replaceAll('{{FILE_COMPONENTS}}', rootComponents.join('\n'))
    .replaceAll('{{FEATURE_COMPONENTS}}', featureRefs.join('\n'));
  writeFileSync(wxsPath, wxs, 'utf8');
}

function generateWingetManifests(args, msiPath) {
  const wingetDir = join(args.outDir, 'winget');
  mkdirSync(wingetDir, { recursive: true });

  const packageIdentifier = 'Xyte.XyteCLI';
  const packageVersion = packageJson.version;
  const installerUrl =
    process.env.XYTE_WINDOWS_INSTALLER_URL?.trim() ||
    `https://github.com/xyte-io/xyte-cli/releases/download/v${packageVersion}/XyteCLI-${packageVersion}-win-x64.msi`;
  const installerSha256 = existsSync(msiPath) ? sha256File(msiPath) : '<sha256-after-msi-build>';
  const manifestVersion = '1.9.0';

  writeFileSync(
    join(wingetDir, `${packageIdentifier}.yaml`),
    [
      `PackageIdentifier: ${packageIdentifier}`,
      `PackageVersion: ${packageVersion}`,
      'DefaultLocale: en-US',
      'ManifestType: version',
      `ManifestVersion: ${manifestVersion}`,
      ''
    ].join('\n'),
    'utf8'
  );

  writeFileSync(
    join(wingetDir, `${packageIdentifier}.installer.yaml`),
    [
      `PackageIdentifier: ${packageIdentifier}`,
      `PackageVersion: ${packageVersion}`,
      'InstallerType: wix',
      'Scope: machine',
      'InstallModes:',
      '- interactive',
      '- silent',
      'UpgradeBehavior: install',
      'Commands:',
      '- xyte-cli',
      'Installers:',
      '- Architecture: x64',
      `  InstallerUrl: ${installerUrl}`,
      `  InstallerSha256: ${installerSha256}`,
      'ManifestType: installer',
      `ManifestVersion: ${manifestVersion}`,
      ''
    ].join('\n'),
    'utf8'
  );

  writeFileSync(
    join(wingetDir, `${packageIdentifier}.locale.en-US.yaml`),
    [
      `PackageIdentifier: ${packageIdentifier}`,
      `PackageVersion: ${packageVersion}`,
      'PackageLocale: en-US',
      'Publisher: Xyte',
      'PackageName: Xyte CLI',
      'License: Apache-2.0',
      'ShortDescription: Agent-first Xyte CLI and console',
      'Description: Xyte CLI operates Xyte fleets from a terminal or shell-capable AI agent.',
      'PackageUrl: https://github.com/xyte-io/xyte-cli',
      'ManifestType: defaultLocale',
      `ManifestVersion: ${manifestVersion}`,
      ''
    ].join('\n'),
    'utf8'
  );

  return wingetDir;
}

async function signMsiIfConfigured(msiPath) {
  if (!process.env.WINDOWS_CODESIGN_PFX_BASE64?.trim()) {
    return false;
  }
  if (process.platform !== 'win32') {
    throw new Error('WINDOWS_CODESIGN_PFX_BASE64 is set, but MSI signing is only supported on Windows runners.');
  }
  await runOrThrow(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(repoRoot, 'scripts', 'sign_windows_msi.ps1'), '-MsiPath', msiPath],
    'Sign Windows MSI'
  );
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  validateArgs(args);
  if (!args.skipMsi) {
    ensureMsiBuildSupported();
  }
  const payloadDir = join(args.outDir, 'payload');
  const wxsPath = join(args.outDir, 'Product.generated.wxs');
  const msiPath = join(args.outDir, `XyteCLI-${packageJson.version}-win-x64.msi`);

  rmSync(payloadDir, { recursive: true, force: true });
  mkdirSync(payloadDir, { recursive: true });

  if (!args.skipBuild) {
    await runOrThrow(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], 'Build xyte-cli');
  }
  ensureBuilt();
  copyPayloadFiles(payloadDir);
  await installProductionDependencies(args, payloadDir);
  await downloadNode(args, payloadDir);
  generateWxs(payloadDir, wxsPath);

  if (!args.skipMsi) {
    await runOrThrow('wix', ['build', wxsPath, '-arch', 'x64', '-out', msiPath, '-acceptEula', wixEulaId], 'Build Windows MSI');
    await signMsiIfConfigured(msiPath);
  }
  const wingetDir = generateWingetManifests(args, msiPath);

  const manifest = {
    schemaVersion: 'xyte.windowsInstallerBuild.v1',
    packageVersion: packageJson.version,
    nodeVersion: args.skipNode ? null : args.nodeVersion,
    wixEulaId,
    payloadDir: manifestRelativePath(args.outDir, payloadDir),
    wxsPath: manifestRelativePath(args.outDir, wxsPath),
    msiPath: args.skipMsi ? null : manifestRelativePath(args.outDir, msiPath),
    wingetDir: manifestRelativePath(args.outDir, wingetDir)
  };
  writeFileSync(join(args.outDir, 'windows-installer-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
