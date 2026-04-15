import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FileProfileStore } from '../../src/secure/profile-store';
import { LinuxSecretServiceStore } from '../../src/secure/secret-store';
import { errorMessage } from '../../src/utils/error-format';
import {
  NODE_COMMAND,
  assertSuccess,
  normalizeJsonOutput,
  printStep,
  runCommand,
  type LoggerLike,
  type RunCommandOptions
} from './shared';

interface LinuxNativeSecretStoreSmokeOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logger?: LoggerLike;
  run?: (
    command: string,
    args: string[],
    options?: RunCommandOptions
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  mkdtempFn?: (prefix: string) => Promise<string>;
  mkdirFn?: (path: string, options?: { recursive?: boolean }) => Promise<unknown>;
  rmFn?: (path: string, options?: { recursive?: boolean; force?: boolean }) => Promise<unknown>;
  writeFileFn?: (path: string, data: string, encoding: BufferEncoding) => Promise<unknown>;
}

function assertSlotSecrets(
  payload: unknown,
  expected: Array<{ provider: string; slotId: string }>
): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Expected JSON object from config key list, got ${JSON.stringify(payload)}`);
  }
  const slots = Array.isArray((payload as { slots?: unknown[] }).slots) ? (payload as { slots: unknown[] }).slots : [];
  for (const item of expected) {
    const match = slots.find((slot) => {
      if (!slot || typeof slot !== 'object' || Array.isArray(slot)) {
        return false;
      }
      return (
        (slot as { provider?: unknown }).provider === item.provider &&
        (slot as { slotId?: unknown }).slotId === item.slotId &&
        (slot as { hasSecret?: unknown }).hasSecret === true
      );
    });
    if (!match) {
      throw new Error(`Expected slot ${item.provider}:${item.slotId} to report hasSecret=true. payload=${JSON.stringify(payload)}`);
    }
  }
}

export async function runLinuxNativeSecretStoreSmoke(
  options: LinuxNativeSecretStoreSmokeOptions = {}
): Promise<void> {
  if (process.platform !== 'linux') {
    throw new Error('linux native secret-store smoke must run on Linux.');
  }

  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const run = options.run ?? runCommand;
  const tempRoot = await (options.mkdtempFn ?? mkdtemp)(path.join(tmpdir(), 'xyte-cli-linux-native-secret-store-'));
  const configDir = path.join(tempRoot, 'config');
  const nativeEnv = {
    ...env,
    XYTE_CLI_CONFIG_DIR: configDir,
    XYTE_CLI_SECRET_STORE_BACKEND: 'native'
  };
  const legacyPath = path.join(configDir, 'secrets.v1.json');
  const profilePath = path.join(configDir, 'profile.json');
  const builtCliPath = path.resolve(cwd, 'dist', 'bin', 'xyte-cli.js');
  const nativeStore = new LinuxSecretServiceStore(run);
  const profileStore = new FileProfileStore(profilePath);
  const stepTotal = 5;

  try {
    await (options.mkdirFn ?? mkdir)(configDir, { recursive: true });

    printStep(logger, 1, stepTotal, 'Checking raw Linux Secret Service round-trip');
    const availability = await nativeStore.checkAvailability();
    if (!availability.available) {
      throw new Error(`Linux Secret Service round-trip failed: ${availability.reason ?? 'unknown reason'}`);
    }

    printStep(logger, 2, stepTotal, 'Writing and reading a native secret through the built CLI');
    const setupResult = await run(
      NODE_COMMAND,
      [
        builtCliPath,
        'setup',
        'run',
        '--non-interactive',
        '--tenant',
        'native-smoke',
        '--provider',
        'xyte-org',
        '--key-stdin',
        '--connectivity',
        'never',
        '--output',
        'json'
      ],
      { cwd, env: nativeEnv, input: 'native-smoke-key\n' }
    );
    assertSuccess(setupResult, 'xyte-cli setup run', NODE_COMMAND, [
      builtCliPath,
      'setup',
      'run',
      '--non-interactive',
      '--tenant',
      'native-smoke',
      '--provider',
      'xyte-org',
      '--key-stdin',
      '--connectivity',
      'never',
      '--output',
      'json'
    ]);
    const setupPayload = normalizeJsonOutput(setupResult.stdout) as Record<string, unknown>;
    if (setupPayload.tenantId !== 'native-smoke') {
      throw new Error(`Unexpected setup payload: ${JSON.stringify(setupPayload)}`);
    }

    const configPathResult = await run(NODE_COMMAND, [builtCliPath, 'config', 'path', '--output', 'json'], {
      cwd,
      env: nativeEnv
    });
    assertSuccess(configPathResult, 'xyte-cli config path', NODE_COMMAND, [builtCliPath, 'config', 'path', '--output', 'json']);
    const configPathPayload = normalizeJsonOutput(configPathResult.stdout) as Record<string, unknown>;
    if (configPathPayload.secretStoreBackend !== 'secret-service' || configPathPayload.secretStore !== 'xyte-cli') {
      throw new Error(`CLI did not resolve the native Linux backend: ${JSON.stringify(configPathPayload)}`);
    }
    if ((await nativeStore.getSlotSecret('native-smoke', 'xyte-org', 'primary')) !== 'native-smoke-key') {
      throw new Error('Native secret written through setup run did not round-trip from Linux Secret Service.');
    }

    const nativeListResult = await run(
      NODE_COMMAND,
      [builtCliPath, 'config', 'key', 'list', '--tenant', 'native-smoke', '--provider', 'xyte-org', '--format', 'json', '--output', 'json'],
      { cwd, env: nativeEnv }
    );
    assertSuccess(nativeListResult, 'xyte-cli config key list', NODE_COMMAND, [
      builtCliPath,
      'config',
      'key',
      'list',
      '--tenant',
      'native-smoke',
      '--provider',
      'xyte-org',
      '--format',
      'json',
      '--output',
      'json'
    ]);
    assertSlotSecrets(normalizeJsonOutput(nativeListResult.stdout), [{ provider: 'xyte-org', slotId: 'primary' }]);

    printStep(logger, 3, stepTotal, 'Seeding legacy metadata and multi-key plaintext secrets');
    await profileStore.upsertTenant({ id: 'migrate-acme', apiProvider: 'xyte-org' });
    await profileStore.addKeySlot('migrate-acme', 'xyte-org', {
      name: 'primary',
      slotId: 'primary',
      fingerprint: 'sha256:migrate-acme-org'
    });
    await profileStore.addKeySlot('migrate-acme', 'xyte-partner', {
      name: 'partner-primary',
      slotId: 'partner-primary',
      fingerprint: 'sha256:migrate-acme-partner'
    });
    await profileStore.upsertTenant({ id: 'migrate-globex', apiProvider: 'xyte-org' });
    await profileStore.addKeySlot('migrate-globex', 'xyte-org', {
      name: 'secondary',
      slotId: 'secondary',
      fingerprint: 'sha256:migrate-globex-org'
    });
    await (options.writeFileFn ?? writeFile)(
      legacyPath,
      `${JSON.stringify(
        {
          version: 1,
          records: {
            'migrate-acme:xyte-org:primary': 'migrate-acme-org-key',
            'migrate-acme:xyte-partner:partner-primary': 'migrate-acme-partner-key',
            'migrate-globex:xyte-org:secondary': 'migrate-globex-org-key'
          }
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    printStep(logger, 4, stepTotal, 'Triggering native migration through CLI reads');
    const migrateAcmeResult = await run(
      NODE_COMMAND,
      [builtCliPath, 'config', 'key', 'list', '--tenant', 'migrate-acme', '--format', 'json', '--output', 'json'],
      { cwd, env: nativeEnv }
    );
    assertSuccess(migrateAcmeResult, 'xyte-cli config key list', NODE_COMMAND, [
      builtCliPath,
      'config',
      'key',
      'list',
      '--tenant',
      'migrate-acme',
      '--format',
      'json',
      '--output',
      'json'
    ]);
    assertSlotSecrets(normalizeJsonOutput(migrateAcmeResult.stdout), [
      { provider: 'xyte-org', slotId: 'primary' },
      { provider: 'xyte-partner', slotId: 'partner-primary' }
    ]);

    const migrateGlobexResult = await run(
      NODE_COMMAND,
      [builtCliPath, 'config', 'key', 'list', '--tenant', 'migrate-globex', '--provider', 'xyte-org', '--format', 'json', '--output', 'json'],
      { cwd, env: nativeEnv }
    );
    assertSuccess(migrateGlobexResult, 'xyte-cli config key list', NODE_COMMAND, [
      builtCliPath,
      'config',
      'key',
      'list',
      '--tenant',
      'migrate-globex',
      '--provider',
      'xyte-org',
      '--format',
      'json',
      '--output',
      'json'
    ]);
    assertSlotSecrets(normalizeJsonOutput(migrateGlobexResult.stdout), [{ provider: 'xyte-org', slotId: 'secondary' }]);

    printStep(logger, 5, stepTotal, 'Verifying migrated secrets and legacy file removal');
    if (existsSync(legacyPath)) {
      throw new Error(`Expected legacy secret file to be deleted after migration: ${legacyPath}`);
    }
    if ((await nativeStore.getSlotSecret('migrate-acme', 'xyte-org', 'primary')) !== 'migrate-acme-org-key') {
      throw new Error('Migrated secret mismatch for migrate-acme:xyte-org:primary');
    }
    if ((await nativeStore.getSlotSecret('migrate-acme', 'xyte-partner', 'partner-primary')) !== 'migrate-acme-partner-key') {
      throw new Error('Migrated secret mismatch for migrate-acme:xyte-partner:partner-primary');
    }
    if ((await nativeStore.getSlotSecret('migrate-globex', 'xyte-org', 'secondary')) !== 'migrate-globex-org-key') {
      throw new Error('Migrated secret mismatch for migrate-globex:xyte-org:secondary');
    }

    logger.log('Linux native secret-store smoke passed using Secret Service.');
  } finally {
    await Promise.allSettled([
      nativeStore.clearSlotSecret('native-smoke', 'xyte-org', 'primary'),
      nativeStore.clearSlotSecret('migrate-acme', 'xyte-org', 'primary'),
      nativeStore.clearSlotSecret('migrate-acme', 'xyte-partner', 'partner-primary'),
      nativeStore.clearSlotSecret('migrate-globex', 'xyte-org', 'secondary')
    ]);
    await (options.rmFn ?? rm)(tempRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  runLinuxNativeSecretStoreSmoke().catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
