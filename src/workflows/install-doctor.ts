import { realpathSync } from 'node:fs';
import path from 'node:path';

import { resolveCommandFromPath } from '../utils/resolve-command-path';

export interface InstallDoctorResult {
  status: 'ok' | 'missing' | 'mismatch';
  commandOnPath: boolean;
  commandPath?: string;
  commandRealPath?: string;
  expectedPath: string;
  expectedRealPath: string;
  sameTarget: boolean;
  suggestions: string[];
}

interface BuildInstallDoctorOptions {
  commandName?: string;
  envPath?: string;
  platform?: NodeJS.Platform;
  packageName?: string;
  entrypointRelativePath?: string;
  commandPathResolver?: typeof resolveCommandFromPath;
  realPathResolver?: (value: string) => string;
}

function pathApiFor(platform: NodeJS.Platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function normalizeForComparison(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? value.toLowerCase() : value;
}

function tryGetRealPath(value: string, realPathResolver: (value: string) => string): string | undefined {
  try {
    return realPathResolver(value);
  } catch {
    return undefined;
  }
}

function resolveForReport(
  value: string,
  platformPath: typeof path.posix | typeof path.win32,
  realPathResolver: (value: string) => string
): string {
  return tryGetRealPath(value, realPathResolver) ?? platformPath.resolve(value);
}

function buildWindowsShimTarget(
  commandPath: string,
  packageName: string,
  entrypointRelativePath: string,
  platformPath: typeof path.win32
): string {
  const packageSegments = packageName.split('/').filter(Boolean);
  const entrypointSegments = entrypointRelativePath.split(/[\\/]+/).filter(Boolean);
  return platformPath.resolve(
    platformPath.dirname(commandPath),
    'node_modules',
    ...packageSegments,
    ...entrypointSegments
  );
}

export function buildInstallDoctorReport(
  expectedPath: string,
  options: BuildInstallDoctorOptions = {}
): InstallDoctorResult {
  const platform = options.platform ?? process.platform;
  const platformPath = pathApiFor(platform);
  const realPathResolver = options.realPathResolver ?? realpathSync;
  const commandPathResolver = options.commandPathResolver ?? resolveCommandFromPath;
  const commandName = options.commandName ?? 'xyte-cli';
  const packageName = options.packageName ?? '@xyteai/cli';
  const entrypointRelativePath = options.entrypointRelativePath ?? 'dist/bin/xyte-cli.js';

  const commandPath = commandPathResolver(commandName, options.envPath);
  const commandOnPath = Boolean(commandPath);
  const expectedRealPath = resolveForReport(expectedPath, platformPath, realPathResolver);
  const commandRealPath = commandPath ? resolveForReport(commandPath, platformPath, realPathResolver) : undefined;
  const normalizedExpectedRealPath = normalizeForComparison(expectedRealPath, platform);

  let sameTarget = Boolean(
    commandRealPath && normalizeForComparison(commandRealPath, platform) === normalizedExpectedRealPath
  );

  if (!sameTarget && platform === 'win32' && commandPath) {
    const shimTargetPath = buildWindowsShimTarget(commandPath, packageName, entrypointRelativePath, path.win32);
    const shimTargetRealPath = tryGetRealPath(shimTargetPath, realPathResolver);
    sameTarget = Boolean(
      shimTargetRealPath && normalizeForComparison(shimTargetRealPath, platform) === normalizedExpectedRealPath
    );
  }

  const suggestions: string[] = [];
  if (!commandOnPath) {
    suggestions.push('Run: npm run install:global');
    suggestions.push('Then verify from a different directory: xyte-cli --help');
  } else if (!sameTarget) {
    suggestions.push(`xyte-cli currently points to: ${commandPath}`);
    suggestions.push('Relink this repo globally: npm run reinstall:global');
  } else {
    suggestions.push('Global command wiring looks correct.');
  }

  return {
    status: !commandOnPath ? 'missing' : sameTarget ? 'ok' : 'mismatch',
    commandOnPath,
    commandPath,
    commandRealPath,
    expectedPath,
    expectedRealPath,
    sameTarget,
    suggestions
  };
}
