#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DOCKER_COMMAND = process.platform === 'win32' ? 'docker.exe' : 'docker';
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

function assertSuccess(result, label, command, args) {
  if (result.code === 0) {
    return;
  }
  throw new Error(
    `${label} failed (${result.code}).\n${command} ${args.join(' ')}\nstdout:\n${result.stdout.trim()}\nstderr:\n${result.stderr.trim()}`
  );
}

function parsePackFilename(packStdout) {
  const trimmed = String(packStdout ?? '').trim();
  if (!trimmed) {
    throw new Error('npm pack returned empty output.');
  }
  try {
    const payload = JSON.parse(trimmed);
    if (Array.isArray(payload) && payload[0]?.filename) {
      return String(payload[0].filename);
    }
    if (payload?.filename) {
      return String(payload.filename);
    }
  } catch {
    // continue fallback
  }
  const lines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1];
}

function previousVersion(version) {
  const match = String(version).trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/);
  if (!match) {
    return '0.0.0';
  }
  let major = Number.parseInt(match[1], 10);
  let minor = Number.parseInt(match[2], 10);
  let patch = Number.parseInt(match[3], 10);

  if (patch > 0) {
    patch -= 1;
  } else if (minor > 0) {
    minor -= 1;
    patch = 0;
  } else if (major > 0) {
    major -= 1;
    minor = 0;
    patch = 0;
  }

  const candidate = `${major}.${minor}.${patch}`;
  if (candidate === version) {
    return '0.0.0';
  }
  return candidate;
}

function parseArgs(argv) {
  const args = {
    image: 'node:22-bookworm'
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--image') {
      args.image = argv[index + 1] ?? args.image;
      index += 1;
    }
  }
  return args;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const workDir = mkdtempSync(path.join(tmpdir(), 'xyte-upgrade-controlled-'));
  const artifactDir = path.join(workDir, 'artifacts');
  const repackDir = path.join(workDir, 'repack');
  mkdirSync(artifactDir, { recursive: true });
  mkdirSync(repackDir, { recursive: true });

  let tarballAPath;
  let tarballBPath;

  try {
    const packageJsonPath = path.join(cwd, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    const versionB = String(packageJson.version);
    const versionA = previousVersion(versionB);

    const packArgs = ['pack', '--pack-destination', artifactDir, '--json'];
    const pack = await run(NPM_COMMAND, packArgs, { cwd, env: process.env });
    assertSuccess(pack, 'npm pack (tarball B)', NPM_COMMAND, packArgs);
    const tarballBName = parsePackFilename(pack.stdout);
    tarballBPath = path.join(artifactDir, tarballBName);

    const extractArgs = ['-xzf', tarballBPath, '-C', repackDir];
    const extract = await run('tar', extractArgs, { cwd, env: process.env });
    assertSuccess(extract, 'extract tarball B', 'tar', extractArgs);

    const repackPackageJsonPath = path.join(repackDir, 'package', 'package.json');
    const repackPackageJson = JSON.parse(readFileSync(repackPackageJsonPath, 'utf8'));
    repackPackageJson.version = versionA;
    writeFileSync(repackPackageJsonPath, `${JSON.stringify(repackPackageJson, null, 2)}\n`, 'utf8');

    const tarballAName = `${String(repackPackageJson.name).replace('@', '').replace('/', '-')}-${versionA}.tgz`;
    tarballAPath = path.join(artifactDir, tarballAName);
    const repackArgs = ['-czf', tarballAPath, '-C', repackDir, 'package'];
    const repack = await run('tar', repackArgs, { cwd, env: process.env });
    assertSuccess(repack, 'create tarball A', 'tar', repackArgs);

    const dockerArgs = [
      'run',
      '--rm',
      '-v',
      `${cwd}:/repo`,
      '-v',
      `${artifactDir}:/artifacts`,
      '-e',
      `XYTE_SMOKE_TARBALL_A=/artifacts/${path.basename(tarballAPath)}`,
      '-e',
      `XYTE_SMOKE_TARBALL_B=/artifacts/${path.basename(tarballBPath)}`,
      '-e',
      `XYTE_SMOKE_VERSION_A=${versionA}`,
      '-e',
      `XYTE_SMOKE_VERSION_B=${versionB}`,
      options.image,
      'node',
      '/repo/scripts/smoke_upgrade_controlled_inner.mjs'
    ];
    const docker = await run(DOCKER_COMMAND, dockerArgs, { cwd, env: process.env });
    assertSuccess(docker, 'controlled docker smoke', DOCKER_COMMAND, dockerArgs);
    process.stdout.write(docker.stdout);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
