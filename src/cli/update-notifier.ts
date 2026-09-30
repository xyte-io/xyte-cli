import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { CliOutputMode } from '../config/settings';
import { getXyteConfigDir } from '../utils/config-dir';
import type { ErrorStream } from './cli-context';
import { checkForUpgrade, type UpgradeDependencies } from './upgrade';

const DEFAULT_PACKAGE_NAME = '@xyteai/cli';
const CLI_DISPLAY_NAME = 'xyte-cli';
const UPGRADE_COMMAND_PATH = 'xyte-cli upgrade';
const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FAILURE_RETRY_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 1500;

interface UpdateNotifierCache {
  version?: number;
  checkedAtUtc?: string;
  checkFailed?: boolean;
}

export interface UpdateNotifierOutputConfig {
  outputMode: CliOutputMode;
  strictJson: boolean;
}

export interface UpdateNotifierOptions {
  commandPath: string;
  env: NodeJS.ProcessEnv;
  stderr: ErrorStream;
  isInteractive: boolean;
  stdoutIsTTY: boolean;
  commandOutputIsMachineReadable?: boolean;
  resolveOutputConfig?: () => Promise<UpdateNotifierOutputConfig>;
  upgradeDependencies?: UpgradeDependencies;
  now?: () => Date;
  checkIntervalMs?: number;
  failureRetryIntervalMs?: number;
  fetchTimeoutMs?: number;
}

export interface UpdateNotifierResult {
  notified: boolean;
  checked: boolean;
  reason?: string;
}

export type UpdateNotifier = (options: UpdateNotifierOptions) => Promise<UpdateNotifierResult>;

function readCache(filePath: string): UpdateNotifierCache {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    const cache = parsed as UpdateNotifierCache;
    return cache.version === undefined || cache.version === 1 ? cache : {};
  } catch {
    return {};
  }
}

function writeCache(filePath: string, cache: UpdateNotifierCache): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  return !['', '0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function isCi(env: NodeJS.ProcessEnv): boolean {
  return [
    env.CI,
    env.GITHUB_ACTIONS,
    env.GITLAB_CI,
    env.BUILDKITE,
    env.CIRCLECI,
    env.TRAVIS,
    env.TEAMCITY_VERSION,
    env.TF_BUILD
  ].some((value) => isTruthyEnv(value));
}

function shouldSkipNotification(options: UpdateNotifierOptions): string | undefined {
  if (isTruthyEnv(options.env.XYTE_CLI_NO_UPDATE_NOTIFIER)) {
    return 'opt-out';
  }
  if (isCi(options.env)) {
    return 'ci';
  }
  if (options.env.NODE_ENV === 'test') {
    return 'test';
  }
  if (!options.isInteractive || !options.stdoutIsTTY) {
    return 'non-interactive';
  }
  if (options.commandPath === UPGRADE_COMMAND_PATH) {
    return 'upgrade-command';
  }
  if (options.commandOutputIsMachineReadable === true) {
    return 'machine-output';
  }
  return undefined;
}

function createAbortableFetch(fetchImpl: typeof fetch, signal: AbortSignal): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    return fetchImpl(input, {
      ...init,
      signal: init?.signal ?? signal
    });
  }) as typeof fetch;
}

async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error('Update check timed out.'));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function maybeNotifyUpdateAvailable(options: UpdateNotifierOptions): Promise<UpdateNotifierResult> {
  const skipReason = shouldSkipNotification(options);
  if (skipReason) {
    return { notified: false, checked: false, reason: skipReason };
  }

  const now = (options.now ?? (() => new Date()))();
  const nowMs = now.getTime();
  const cachePath = join(getXyteConfigDir(options.env), 'update-notifier.json');
  const cache = readCache(cachePath);
  const checkedAtMs = parseTime(cache.checkedAtUtc);
  const intervalMs = cache.checkFailed
    ? (options.failureRetryIntervalMs ?? DEFAULT_FAILURE_RETRY_INTERVAL_MS)
    : (options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS);

  if (checkedAtMs !== undefined) {
    const elapsedMs = nowMs - checkedAtMs;
    // A future-dated timestamp (clock rollback, copied cache) counts as stale, not fresh.
    if (elapsedMs >= 0 && elapsedMs < intervalMs) {
      return { notified: false, checked: false, reason: 'recently-checked' };
    }
  }

  if (options.resolveOutputConfig) {
    const output = await options.resolveOutputConfig().catch(() => undefined);
    if (output && (output.outputMode === 'json' || output.strictJson)) {
      return { notified: false, checked: false, reason: 'configured-json' };
    }
  }

  // Stamp before fetching: if the cache is unwritable, bail out instead of
  // fetching and notifying on every single run. The checkFailed stamp keeps
  // the retry window short until a check actually succeeds.
  try {
    writeCache(cachePath, { version: 1, checkedAtUtc: now.toISOString(), checkFailed: true });
  } catch {
    return { notified: false, checked: false, reason: 'cache-unwritable' };
  }

  try {
    const latestVersionOverride = options.env.XYTE_CLI_UPGRADE_TARGET_VERSION?.trim() || undefined;
    const baseFetch = options.upgradeDependencies?.fetchImpl ?? fetch;
    const check = await withTimeout(
      (signal) =>
        checkForUpgrade(
          {
            packageName: DEFAULT_PACKAGE_NAME,
            latestVersionOverride
          },
          {
            ...options.upgradeDependencies,
            fetchImpl: createAbortableFetch(baseFetch, signal)
          }
        ),
      options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
    );
    writeCache(cachePath, { version: 1, checkedAtUtc: now.toISOString() });

    if (!check.upToDate) {
      options.stderr.write(
        `A new version of ${CLI_DISPLAY_NAME} is available: ${check.currentVersion} -> ${check.latestVersion}\n` +
          `To upgrade, run: ${CLI_DISPLAY_NAME} upgrade\n`
      );
      return { notified: true, checked: true };
    }

    return { notified: false, checked: true, reason: 'up-to-date' };
  } catch {
    return { notified: false, checked: true, reason: 'check-failed' };
  }
}
