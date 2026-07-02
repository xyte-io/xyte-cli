#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const requiredFiles = [
  'packaging/windows/Product.wxs.template',
  'packaging/windows/scripts/configure-xyte-cli.ps1',
  'scripts/package_windows_msi.mjs',
  'scripts/sign_windows_msi.ps1'
];

for (const file of requiredFiles) {
  if (!existsSync(join(repoRoot, file))) {
    throw new Error(`Missing Windows packaging file: ${file}`);
  }
}

const assistant = readFileSync(join(repoRoot, 'packaging/windows/scripts/configure-xyte-cli.ps1'), 'utf8');
for (const expected of [
  'npm uninstall -g @xyteai/cli',
  '"setup", "run"',
  '--key-file',
  '"doctor", "environment"',
  'Get-Command "xyte-cli" -All',
  '$LASTEXITCODE',
  '"setup", "status", "--field", "state"',
  '-eq "ready"',
  'setup still needs an API key'
]) {
  if (!assistant.includes(expected)) {
    throw new Error(`Windows setup assistant is missing expected behavior: ${expected}`);
  }
}

const packageScript = readFileSync(join(repoRoot, 'scripts/package_windows_msi.mjs'), 'utf8');
for (const expected of [
  "const wixEulaId = 'wix7'",
  "'-acceptEula', wixEulaId",
  'Building a Windows MSI with WiX is supported only on Windows',
  'SHASUMS256.txt',
  'Node.js runtime checksum mismatch',
  "kind: 'windows-msi'",
  "packageId: 'Xyte.XyteCLI'"
]) {
  if (!packageScript.includes(expected)) {
    throw new Error(`Windows packaging script is missing expected behavior: ${expected}`);
  }
}

const releaseWorkflow = readFileSync(join(repoRoot, '.github/workflows/release-assets.yml'), 'utf8');
for (const expected of ['Publish Windows release assets', 'Verify Windows release assets', 'windows-checksums.txt']) {
  if (!releaseWorkflow.includes(expected)) {
    throw new Error(`Release workflow is missing expected Windows release behavior: ${expected}`);
  }
}

const template = readFileSync(join(repoRoot, 'packaging/windows/Product.wxs.template'), 'utf8');
for (const expected of [
  'PathEnvironment',
  'StartMenuShortcuts',
  'Configure Xyte CLI',
  'LaunchConfigureXyteCli',
  'Condition="NOT Installed AND NOT WIX_UPGRADE_DETECTED AND UILevel &gt;= 5"',
  '{{FILE_COMPONENTS}}'
]) {
  if (!template.includes(expected)) {
    throw new Error(`WiX template is missing expected marker: ${expected}`);
  }
}

const windowsDocs = readFileSync(join(repoRoot, 'docs/windows-installer.md'), 'utf8');
for (const expected of [
  'The MSI does not replace the Node/npm install path.',
  'npm uninstall -g @xyteai/cli',
  'winget upgrade --id Xyte.XyteCLI --exact',
  'API key is not passed through MSI properties',
  'For an interactive first install, the MSI launches',
  '-acceptEula wix7'
]) {
  if (!windowsDocs.includes(expected)) {
    throw new Error(`Windows installer docs are missing expected guidance: ${expected}`);
  }
}

process.stdout.write('Windows packaging validation passed.\n');
