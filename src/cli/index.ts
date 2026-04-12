import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { Writable } from 'node:stream';

import { Command } from 'commander';

import { createCliActionLogger, sanitizeArgvForLog, type CliActionLogger } from './action-logger';
import { createXyteClient } from '../client/create-client';
import { toProblemDetails } from '../client/errors';
import { buildStatusContract, type StatusMode } from '../contracts/status';
import { evaluateReadiness, type ReadinessCheck } from '../config/readiness';
import {
  resolveCliSettingsSync,
  type CliOutputMode,
  type ResolvedCliSettingsState,
  type SettingKey
} from '../config/settings';
import { createSecretStore, type SecretStore } from '../secure/secret-store';
import { createProfileStore, type ProfileStore } from '../secure/profile-store';
import { buildInstallDoctorReport, type InstallDoctorResult } from '../utils/install-doctor';
import { getCliVersion } from '../utils/version';
import {
  installSkills,
  type SkillAgent,
  type SkillInstallOutcome,
  type SkillInstallScope
} from '../utils/install-skills';
import { applyUpgrade, checkForUpgrade, type UpgradeDependencies } from '../utils/upgrade';
import { runTuiApp } from '../tui/app';
import { CliUserError } from '../contracts/user-error';
import { errorMessage } from '../utils/error-format';
import { registerLogsCommands } from './commands/logs';
import { registerConfigCommands } from './commands/config';
import { registerFlowCommands } from './commands/flow';
import {
  registerSetupCommands,
  SIMPLE_SETUP_DEFAULT_TENANT,
  normalizeTenantId,
  runSimpleSetup
} from './commands/setup';
import { registerOpsCommands } from './commands/ops';
import { registerApiCommands } from './commands/api';
import { registerUtilCommands } from './commands/util';
import { formatReadinessText } from './format-readiness';
import { resolveKeyValue } from './resolve-key';
import {
  getExplicitGlobalOutput,
  printJson,
  resolveStrictJson,
  resolveTextJsonOutput,
  type CliContext,
  type ErrorStream,
  type OutputFormat,
  type OutputStream,
  type PromptValueFn
} from './cli-context';

interface CliGlobalOptions {
  output?: CliOutputMode;
  logActions?: boolean;
  logActionsPath?: string;
  logActionsVerbose?: boolean;
}

interface ActiveCliAction {
  commandPath: string;
  startedAt: number;
}

interface CliActionLogState {
  logger?: CliActionLogger;
  activeAction?: ActiveCliAction;
  verbose?: boolean;
}

// Use a symbol to avoid collisions with Commander internals or plugin-added properties.
const CLI_ACTION_LOG_STATE = Symbol('xyte-cli-action-log-state');

type CliProgramWithActionLogState = Command & {
  [CLI_ACTION_LOG_STATE]?: () => CliActionLogState;
};

interface CliRuntime {
  profileStore?: ProfileStore;
  secretStore?: SecretStore;
  stdout?: OutputStream;
  stderr?: ErrorStream;
  runTui?: typeof runTuiApp;
  promptValue?: PromptValueFn;
  readStdinValue?: () => Promise<string>;
  isTTY?: boolean;
  stdoutIsTTY?: boolean;
  upgradeDependencies?: UpgradeDependencies;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const SKILL_AGENTS: SkillAgent[] = ['claude', 'copilot', 'codex'];
const SKILL_SCOPES: SkillInstallScope[] = ['project', 'user', 'both'];

function commandPathFor(command: Command): string {
  const names: string[] = [];
  let current: Command | undefined = command;
  while (current) {
    const name = current.name();
    if (name) {
      names.unshift(name);
    }
    current = current.parent ?? undefined;
  }
  return names.join(' ');
}

function argvForCommand(command: Command): string[] {
  let root: Command = command;
  while (root.parent) {
    root = root.parent;
  }

  const rootWithRawArgs = root as Command & { rawArgs?: string[] };
  const rawArgs = Array.isArray(rootWithRawArgs.rawArgs) ? rootWithRawArgs.rawArgs : process.argv;
  if (!Array.isArray(rawArgs) || rawArgs.length <= 2) {
    return [];
  }
  return rawArgs.slice(2);
}

function inferCommandPathFromArgv(argv: string[]): string {
  if (argv.length < 2) {
    return 'xyte-cli';
  }

  const commandParts: string[] = [];
  for (const token of argv.slice(1)) {
    if (!token || token.startsWith('-')) {
      continue;
    }
    commandParts.push(token);
    if (commandParts.length >= 3) {
      break;
    }
  }

  if (!commandParts.length) {
    return 'xyte-cli';
  }
  return commandParts.join(' ');
}

function resolveSkillSourceDir(): string {
  return path.resolve(__dirname, '../../skills/xyte-cli');
}

function parseSkillInstallScope(value: string | undefined): SkillInstallScope | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!SKILL_SCOPES.includes(normalized as SkillInstallScope)) {
    throw new CliUserError({ summary: `Invalid scope: ${value}. Expected one of: ${SKILL_SCOPES.join(', ')}.` });
  }
  return normalized as SkillInstallScope;
}

function parseSkillAgents(value: string | undefined): SkillAgent[] | undefined {
  if (!value) {
    return undefined;
  }

  const tokens = value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  if (!tokens.length) {
    throw new CliUserError({ summary: 'Invalid agents: empty value.' });
  }

  if (tokens.includes('all')) {
    if (tokens.length > 1) {
      throw new CliUserError({ summary: 'Invalid agents: "all" cannot be combined with specific agents.' });
    }
    return [...SKILL_AGENTS];
  }

  const unknown = tokens.filter((item) => !SKILL_AGENTS.includes(item as SkillAgent));
  if (unknown.length > 0) {
    throw new CliUserError({ summary: `Invalid agents: ${unknown.join(', ')}. Expected "all" or ${SKILL_AGENTS.join(', ')}.` });
  }

  return SKILL_AGENTS.filter((agent) => tokens.includes(agent));
}

function formatInstallOutcome(outcome: SkillInstallOutcome): string {
  const prefix = `${outcome.scope}/${outcome.agent}`;
  if (outcome.status === 'failed') {
    return `- ${prefix}: failed -> ${outcome.targetDir} (${outcome.error ?? 'unknown error'})`;
  }
  if (outcome.status === 'skipped') {
    return `- ${prefix}: skipped -> ${outcome.targetDir} (already exists; use --force to overwrite)`;
  }
  return `- ${prefix}: ${outcome.status} -> ${outcome.targetDir}`;
}

function parseStatusMode(value: string | undefined): StatusMode {
  const normalized = (value ?? 'fast').trim().toLowerCase();
  if (normalized !== 'fast' && normalized !== 'full') {
    throw new CliUserError({ summary: `Invalid status mode: ${value}. Use fast|full.` });
  }
  return normalized as StatusMode;
}

function runInstallDoctor(): InstallDoctorResult {
  const expectedPath = path.resolve(__dirname, '../../dist/bin/xyte-cli.js');
  return buildInstallDoctorReport(expectedPath);
}

async function promptValue(args: {
  question: string;
  initial?: string;
  stdout: OutputStream;
  secret?: boolean;
}): Promise<string> {
  const mutedOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
  const rl = createInterface({
    input: process.stdin,
    output: args.secret ? mutedOutput : process.stdout,
    terminal: true
  });
  try {
    const suffix = args.initial ? ` [${args.initial}]` : '';
    if (args.secret) {
      args.stdout.write(`${args.question}${suffix}: `);
    }
    const answer = (await rl.question(args.secret ? '' : `${args.question}${suffix}: `)).trim();
    if (args.secret) {
      args.stdout.write('\n');
    }
    return answer || args.initial || '';
  } finally {
    rl.close();
  }
}

async function readStdinValue(): Promise<string> {
  const chunks: string[] = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return chunks.join('').trim();
}

interface RootLauncherPayload {
  schemaVersion: 'xyte.root.launcher.v1';
  generatedAtUtc: string;
  readiness: ReadinessCheck;
  configured: boolean;
  settings: {
    tenantId?: string;
    outputMode: CliOutputMode;
    consoleScreen: string | undefined;
  };
  sections: Array<{
    title: string;
    description: string;
    commands: string[];
  }>;
}

function buildRootLauncherPayload(args: {
  readiness: ReadinessCheck;
  settings: ResolvedCliSettingsState;
}): RootLauncherPayload {
  const tenantId = args.settings.values.defaults.tenant ?? args.readiness.tenantId ?? SIMPLE_SETUP_DEFAULT_TENANT;
  const configured = args.readiness.state === 'ready';
  const sections = configured
    ? [
        {
          title: 'Everyday Ops',
          description: 'Operator flows and fleet visibility.',
          commands: [
            `xyte-cli ops watch incidents --tenant ${tenantId} --once --output json --strict-json`,
            `xyte-cli ops inspect fleet --tenant ${tenantId} --output json`,
            `xyte-cli ops inspect deep-dive --tenant ${tenantId} --render markdown`
          ]
        },
        {
          title: 'Raw API',
          description: 'Direct endpoint discovery and invocation.',
          commands: [
            `xyte-cli api endpoints list --tenant ${tenantId}`,
            `xyte-cli api endpoints describe organization.devices.getDevices`,
            `xyte-cli api call organization.devices.getDevices --tenant ${tenantId} --output json`
          ]
        },
        {
          title: 'Config & Credentials',
          description: 'Inspect resolved settings, tenants, and key slots.',
          commands: [
            'xyte-cli config show --scope resolved',
            `xyte-cli config tenant use ${tenantId}`,
            `xyte-cli config key list --tenant ${tenantId} --output text`
          ]
        },
        {
          title: 'Console / Headless',
          description: 'Interactive console and machine-readable frames.',
          commands: [
            `xyte-cli ops console --screen ${args.settings.values.console.screen ?? 'dashboard'}`,
            `xyte-cli ops console --headless --screen dashboard --tenant ${tenantId} --output json`
          ]
        },
        {
          title: 'Examples',
          description: 'Task-first shortcuts.',
          commands: [
            `xyte-cli flow run flow.daily-deep-dive-report --tenant ${tenantId} --plan`,
            `xyte-cli util prepare --action organization.devices.claimDevice --tenant ${tenantId} --input ./claims.csv`
          ]
        }
      ]
    : [
        {
          title: 'Setup',
          description: 'First-run onboarding and readiness checks.',
          commands: [
            `xyte-cli setup run --tenant ${tenantId}`,
            `xyte-cli setup status --tenant ${tenantId}`,
            `xyte-cli config doctor --tenant ${tenantId}`
          ]
        },
        {
          title: 'Everyday Ops',
          description: 'Console entrypoints become useful after setup succeeds.',
          commands: [`xyte-cli ops console --screen setup`, `xyte-cli status --mode full --tenant ${tenantId}`]
        },
        {
          title: 'Raw API',
          description: 'Once credentials exist, raw API calls live under api.',
          commands: [
            `xyte-cli api endpoints list --tenant ${tenantId}`,
            `xyte-cli api call organization.getOrganizationInfo --tenant ${tenantId}`
          ]
        },
        {
          title: 'Config & Credentials',
          description: 'Store tenants, key slots, and layered defaults.',
          commands: [
            'xyte-cli config show --scope resolved',
            `xyte-cli config tenant add ${tenantId}`,
            `xyte-cli config key add --tenant ${tenantId} --provider xyte-org --name primary`
          ]
        },
        {
          title: 'Console / Headless',
          description: 'Root no longer auto-opens the console.',
          commands: [
            `xyte-cli ops console --screen setup`,
            `xyte-cli ops console --headless --screen setup --output json`
          ]
        },
        {
          title: 'Examples',
          description: 'Canonical v2 entrypoints.',
          commands: ['xyte-cli init --scope both --agents all', 'xyte-cli --output json']
        }
      ];

  return {
    schemaVersion: 'xyte.root.launcher.v1',
    generatedAtUtc: new Date().toISOString(),
    readiness: args.readiness,
    configured,
    settings: {
      tenantId: args.settings.values.defaults.tenant,
      outputMode: args.settings.values.output.mode,
      consoleScreen: args.settings.values.console.screen
    },
    sections
  };
}

function formatRootLauncherText(payload: RootLauncherPayload): string {
  const lines = [
    'xyte-cli',
    `Readiness: ${payload.readiness.state}`,
    `Tenant: ${payload.readiness.tenantId ?? 'none'}`,
    `Connectivity: ${payload.readiness.connectionState} (${payload.readiness.connectivity.message})`
  ];

  for (const section of payload.sections) {
    lines.push('');
    lines.push(section.title);
    lines.push(section.description);
    for (const command of section.commands) {
      lines.push(`- ${command}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function createCli(runtime: CliRuntime = {}): Command {
  const stdout = runtime.stdout ?? process.stdout;
  const stderr = runtime.stderr ?? process.stderr;
  const prompt = runtime.promptValue ?? promptValue;
  const readStdin = runtime.readStdinValue ?? readStdinValue;
  const isInteractive = runtime.isTTY ?? Boolean(process.stdin.isTTY);
  const stdoutIsTTY =
    runtime.stdoutIsTTY ??
    Boolean(('isTTY' in stdout ? (stdout as typeof process.stdout).isTTY : undefined) ?? process.stdout.isTTY);
  const profileStore = runtime.profileStore ?? createProfileStore();
  const runTui = runtime.runTui ?? runTuiApp;
  const cwd = runtime.cwd ?? process.cwd();
  const env = runtime.env ?? process.env;

  let cachedSecretStore: SecretStore | undefined;
  const getSecretStore = () => {
    if (runtime.secretStore) {
      return runtime.secretStore;
    }
    if (!cachedSecretStore) {
      cachedSecretStore = createSecretStore();
    }
    return cachedSecretStore;
  };

  const resolveSettings = async (flagOverrides: Partial<Record<SettingKey, unknown>> = {}) => {
    const activeTenantId = (await profileStore.getData()).activeTenantId;
    return resolveCliSettingsSync({
      cwd,
      env,
      activeTenantId,
      flagOverrides
    });
  };

  let profileMigrated = false;
  const withClient = async (args?: {
    tenantId?: string;
    retry?: { attempts?: number; backoffMs?: number };
    flagOverrides?: Partial<Record<SettingKey, unknown>>;
  }) => {
    const { tenantId, retry, flagOverrides = {} } = args ?? {};
    if (!profileMigrated) {
      profileMigrated = true;
      await profileStore.migrateIfNeeded();
    }
    const secretStore = getSecretStore();
    const settings = await resolveSettings(flagOverrides);
    const resolvedTenantId = tenantId ?? settings.values.defaults.tenant;
    return createXyteClient({
      profileStore,
      secretStore,
      tenantId: resolvedTenantId,
      retryAttempts: retry?.attempts ?? settings.values.http.retryAttempts,
      retryBackoffMs: retry?.backoffMs ?? settings.values.http.retryBackoffMs
    });
  };

  const handleRootLauncher = async (options: { output?: string } = {}) => {
    const settings = await resolveSettings();
    const tenantId = settings.values.defaults.tenant;
    const secretStore = getSecretStore();
    const client = tenantId ? await withClient({ tenantId }) : undefined;
    const readiness = await evaluateReadiness({
      profileStore,
      secretStore,
      tenantId,
      client,
      checkConnectivity: true
    });
    const payload = buildRootLauncherPayload({ readiness, settings });
    const output = resolveTextJsonOutput({
      output: options.output,
      stdoutIsTTY,
      settings
    });

    if (output === 'text') {
      stdout.write(formatRootLauncherText(payload));
      return;
    }

    printJson(stdout, payload, { strictJson: resolveStrictJson({ settings }) });
  };

  const handleInit = async (options: {
    target?: string;
    scope?: string;
    agents?: string;
    force?: boolean;
    setup?: boolean;
    requireSetup?: boolean;
  }) => {
    let scope = parseSkillInstallScope(options.scope);
    let agents = parseSkillAgents(options.agents);
    if (isInteractive) {
      if (!scope) {
        scope = parseSkillInstallScope(
          await prompt({
            question: 'Install scope (project|user|both)',
            initial: 'project',
            stdout
          })
        );
      }
      if (!agents) {
        agents = parseSkillAgents(
          await prompt({
            question: 'Agents (all|claude,copilot,codex)',
            initial: 'all',
            stdout
          })
        );
      }
    }
    scope = scope ?? 'project';
    agents = agents ?? [...SKILL_AGENTS];

    const skillSource = resolveSkillSourceDir();
    const result = await installSkills({
      skillName: 'xyte-cli',
      sourceDir: skillSource,
      scope,
      agents,
      targetWorkspace: options.target,
      force: options.force === true
    });

    if (scope === 'project' || scope === 'both') {
      stdout.write(`✅ Workspace target: \`${result.workspaceRoot}\`.\n`);
    }
    if (scope === 'user' || scope === 'both') {
      stdout.write(`✅ User target: \`${result.homeRoot}\`.\n`);
    }
    stdout.write('Skill install summary:\n');
    result.outcomes.forEach((outcome) => stdout.write(`${formatInstallOutcome(outcome)}\n`));

    const failed = result.outcomes.filter((outcome) => outcome.status === 'failed');
    if (failed.length > 0) {
      throw new CliUserError({
        summary: 'Skill installation failed.',
        detail: `Failed on ${failed.length} target(s).`,
        suggestedCommands: ['Re-run with xyte-cli init --force', 'Inspect the failed targets reported above.']
      });
    }

    if (options.setup === false) {
      return;
    }

    const keyValue = await resolveKeyValue({
      envKey: env.XYTE_CLI_KEY,
      allowPrompt: isInteractive,
      prompt,
      readStdin,
      promptQuestion: 'XYTE API key',
      stdout
    });
    let tenantLabel = SIMPLE_SETUP_DEFAULT_TENANT;

    if (isInteractive) {
      tenantLabel =
        (
          await prompt({
            question: 'Tenant label (optional)',
            initial: tenantLabel,
            stdout
          })
        ).trim() || SIMPLE_SETUP_DEFAULT_TENANT;
    }

    if (!keyValue) {
      if (options.requireSetup === true) {
        throw new CliUserError({
          summary: 'Missing API key for init setup.',
          detail: 'Neither XYTE_CLI_KEY nor interactive input supplied a key.',
          suggestedCommands: ['Run xyte-cli setup run --tenant <tenant-id>', 'Re-run xyte-cli init --no-setup']
        });
      }
      stdout.write('Setup skipped: no API key was provided.\n');
      stdout.write('Next steps:\n');
      stdout.write('- Run xyte-cli setup run --tenant <tenant-id>\n');
      stdout.write('- Or re-run xyte-cli init --require-setup after setting XYTE_CLI_KEY\n');
      return;
    }

    const tenantId = normalizeTenantId(tenantLabel);
    const setupResult = await runSimpleSetup(cliContext, {
      tenantId,
      tenantName: tenantLabel,
      keyValue,
      setActive: true,
      connectivityMode: 'auto'
    });

    if (setupResult.readiness.state !== 'ready') {
      if (options.requireSetup === true) {
        throw new CliUserError({
          summary: 'Init setup did not complete.',
          detail: setupResult.readiness.connectivity.message || 'Connectivity validation failed.',
          suggestedCommands: [
            `xyte-cli setup status --tenant ${tenantId}`,
            `xyte-cli config doctor --tenant ${tenantId}`
          ]
        });
      }
      stdout.write(`Setup needs follow-up for tenant \`${tenantId}\`.\n`);
      stdout.write(`Next steps: xyte-cli setup status --tenant ${tenantId}\n`);
      stdout.write(`            xyte-cli config doctor --tenant ${tenantId}\n`);
      return;
    }

    stdout.write(`✅ Setup complete for tenant \`${tenantId}\`.\n`);
  };

  const program = new Command();
  // (handler closures extracted to commands/*.ts modules)

  let actionLogger: CliActionLogger | undefined;
  let actionLogVerbose = false;
  let activeAction: ActiveCliAction | undefined;
  const actionStartByCommand = new WeakMap<Command, number>();

  const getOrCreateActionLogger = (command: Command): CliActionLogger => {
    if (actionLogger) {
      return actionLogger;
    }

    const options = command.optsWithGlobals() as CliGlobalOptions;
    const settings = resolveCliSettingsSync({ cwd, env });
    const configuredPath = options.logActionsPath ?? settings.values.logs.path;
    const enabled = options.logActions === true || settings.values.logs.enabled || Boolean(configuredPath);
    const maxFileBytes = settings.values.logs.maxFileBytes;
    const maxFiles = settings.values.logs.maxFiles;
    actionLogVerbose = options.logActionsVerbose === true || settings.values.logs.verbose;

    actionLogger = createCliActionLogger({
      enabled,
      path: configuredPath,
      mirrorToStderr: options.logActions === true || settings.values.logs.mirrorToStderr,
      stderr,
      argv: actionLogVerbose ? argvForCommand(command) : undefined,
      maxFileBytes,
      maxFiles
    });
    return actionLogger;
  };

  program.name('xyte-cli').description('Agent-first Xyte CLI and console').version(getCliVersion());
  program.showSuggestionAfterError(true);
  program.option('--error-format <format>', 'text|json', 'text');
  program.option('--output <mode>', 'auto|json|text', 'auto');
  program.option('--log-actions', 'Log each CLI action (start/complete/error) to NDJSON');
  program.option('--log-actions-path <path>', 'Write action logs to this NDJSON file');
  program.option('--log-actions-verbose', 'Include command args/options payloads in action logs');
  program.addHelpText(
    'after',
    [
      '',
      'Setup:',
      '  xyte-cli init --scope both --agents all',
      '  xyte-cli setup run --non-interactive --tenant <tenant-id> --key-file <path>',
      '',
      'Everyday Ops:',
      '  xyte-cli ops watch incidents --tenant <tenant-id> --once --output json --strict-json',
      '  xyte-cli ops inspect fleet --tenant <tenant-id> --output json',
      '',
      'Raw API:',
      '  xyte-cli api endpoints list --tenant <tenant-id>',
      '  xyte-cli api call organization.devices.getDevices --tenant <tenant-id> --output json',
      '',
      'Config & Credentials:',
      '  xyte-cli config show --scope resolved',
      '  xyte-cli config key list --tenant <tenant-id>',
      '',
      'Console / Headless:',
      '  xyte-cli ops console --screen dashboard',
      '  xyte-cli ops console --headless --screen dashboard --output json',
      '',
      'Examples:',
      '  xyte-cli flow run flow.daily-deep-dive-report --tenant <tenant-id> --plan',
      '  xyte-cli util prepare --action organization.devices.claimDevice --tenant <tenant-id> --input ./claims.csv'
    ].join('\n')
  );

  const cliContext: CliContext = {
    stdout,
    stderr,
    stdoutIsTTY,
    isInteractive,
    profileStore,
    getSecretStore,
    cwd,
    env,
    prompt,
    readStdin,
    resolveSettings,
    withClient,
    logAction(event, data, level) {
      if (!actionLogger?.enabled) {
        return;
      }
      actionLogger.log(event, data, level);
    }
  };

  program
    .command('init')
    .description('Bootstrap workspace skills and optionally run first-time setup')
    .option('--target <path>', 'Workspace directory override')
    .option('--scope <scope>', 'project|user|both')
    .option('--agents <agents>', 'all|claude|copilot|codex[,..]')
    .option('--force', 'Overwrite existing skill install')
    .option('--no-setup', 'Skip guided setup after installing skills')
    .option('--require-setup', 'Fail if guided setup cannot complete')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  xyte-cli init --scope both --agents all',
        '  xyte-cli init --target ./workspace --no-setup'
      ].join('\n')
    )
    .action(handleInit);

  program.action(async (_args: unknown, command: Command) => {
    const options = command.optsWithGlobals() as { output?: string };
    await handleRootLauncher({ output: options.output });
  });

  const doctor = program.command('doctor').description('Runtime diagnostics');

  doctor
    .command('install')
    .description('Check global xyte-cli command wiring')
    .option('--format <format>', 'json|text', 'json')
    .action(async (options: { format?: OutputFormat }, command: Command) => {
      const report = runInstallDoctor();
      const settings = await resolveSettings();
      if (
        resolveTextJsonOutput({
          output: getExplicitGlobalOutput(command),
          format: options.format,
          stdoutIsTTY,
          settings
        }) === 'text'
      ) {
        stdout.write(
          [
            `Status: ${report.status}`,
            `Command on PATH: ${report.commandOnPath}`,
            `Command path: ${report.commandPath ?? 'not found'}`,
            `Command real path: ${report.commandRealPath ?? 'n/a'}`,
            `Expected path: ${report.expectedPath}`,
            `Expected real path: ${report.expectedRealPath}`,
            `Same target: ${report.sameTarget}`,
            '',
            'Suggestions:',
            ...report.suggestions.map((item) => `- ${item}`)
          ].join('\n') + '\n'
        );
        return;
      }
      printJson(stdout, report, { strictJson: resolveStrictJson({ settings }) });
    });

  program
    .command('status')
    .description('Fast readiness status for operators and agents')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--mode <mode>', 'fast|full', 'fast')
    .option('--format <format>', 'json|text', 'json')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  xyte-cli status',
        '  xyte-cli status --mode full --tenant <tenant-id>',
        '  xyte-cli status --output json'
      ].join('\n')
    )
    .action(async (options: { tenant?: string; mode?: string; format?: OutputFormat }, command: Command) => {
      const globals = command.optsWithGlobals() as { output?: string };
      const settings = await resolveSettings(options.tenant ? { 'defaults.tenant': options.tenant } : {});
      const mode = parseStatusMode(options.mode);
      const checkConnectivity = mode === 'full';
      const tenantId = options.tenant ?? settings.values.defaults.tenant;
      const secretStore = getSecretStore();
      const client = checkConnectivity ? await withClient({ tenantId }) : undefined;
      const readiness = await evaluateReadiness({
        profileStore,
        secretStore,
        tenantId,
        client,
        checkConnectivity
      });
      const payload = buildStatusContract({
        mode,
        checkConnectivity,
        readiness
      });

      if (
        resolveTextJsonOutput({
          output: globals.output,
          format: options.format,
          stdoutIsTTY,
          settings
        }) === 'text'
      ) {
        stdout.write(`Status mode: ${payload.mode}\n`);
        stdout.write(`Generated: ${payload.generatedAtUtc}\n`);
        stdout.write(formatReadinessText(readiness));
        return;
      }

      printJson(stdout, payload, { strictJson: resolveStrictJson({ settings }) });
    });

  program
    .command('upgrade')
    .description('Update xyte-cli and refresh user-scope agent skills')
    .option('--check', 'Check current and latest version without upgrading')
    .option('--yes', 'Skip confirmation prompt')
    .option('--format <format>', 'json|text', 'json')
    .action(async (options: { check?: boolean; yes?: boolean; format?: OutputFormat }, command: Command) => {
      const settings = await resolveSettings();
      const output = resolveTextJsonOutput({
        output: getExplicitGlobalOutput(command),
        format: options.format,
        stdoutIsTTY,
        settings
      });
      const latestVersionOverride = process.env.XYTE_CLI_UPGRADE_TARGET_VERSION?.trim() || undefined;
      const installSpec = process.env.XYTE_CLI_UPGRADE_SPEC?.trim() || undefined;
      const check = await checkForUpgrade(
        { packageName: '@xyteai/cli', latestVersionOverride },
        runtime.upgradeDependencies
      );
      if (options.check) {
        if (output === 'text') {
          stdout.write(`Package: ${check.packageName}\n`);
          stdout.write(`Current: ${check.currentVersion}\n`);
          stdout.write(`Latest: ${check.latestVersion}\n`);
          stdout.write(`Up to date: ${check.upToDate}\n`);
          if (check.recommendedCommand) {
            stdout.write(`Recommended: ${check.recommendedCommand}\n`);
          }
          return;
        }
        printJson(stdout, check, { strictJson: resolveStrictJson({ settings }) });
        return;
      }

      if (!options.yes) {
        if (!isInteractive) {
          throw new CliUserError({ summary: 'Upgrade requires confirmation. Re-run with --yes or use --check.' });
        }
        const answer = (
          await prompt({
            question: 'Proceed with global CLI update and user-scope skills refresh? (y/N)',
            initial: 'N',
            stdout
          })
        )
          .trim()
          .toLowerCase();
        if (!['y', 'yes'].includes(answer)) {
          if (output === 'text') {
            stdout.write('Upgrade canceled.\n');
          } else {
            printJson(stdout, check, { strictJson: resolveStrictJson({ settings }) });
          }
          return;
        }
      }

      const result = await applyUpgrade(
        {
          packageName: check.packageName,
          skillSourceDir: resolveSkillSourceDir(),
          installSpec,
          latestVersionOverride
        },
        runtime.upgradeDependencies
      );

      if (output === 'text') {
        stdout.write(`Package: ${result.packageName}\n`);
        stdout.write(`Current: ${result.currentVersion}\n`);
        stdout.write(`Latest: ${result.latestVersion}\n`);
        stdout.write(`Updated: ${result.updated}\n`);
        stdout.write(`Verified version: ${result.verify.detectedVersion}\n`);
        stdout.write('Skill refresh summary:\n');
        result.skills.outcomes.forEach((outcome) => stdout.write(`${formatInstallOutcome(outcome)}\n`));
        if (result.warnings.length > 0) {
          stdout.write('Warnings:\n');
          result.warnings.forEach((warning) => stdout.write(`- ${warning}\n`));
        }
        return;
      }

      printJson(stdout, result, { strictJson: resolveStrictJson({ settings }) });
    });

  registerApiCommands(program, cliContext);
  registerOpsCommands(program, cliContext, runTui);
  registerUtilCommands(program, cliContext);
  registerFlowCommands(program, cliContext);
  registerSetupCommands(program, cliContext);
  registerConfigCommands(program, cliContext);
  registerLogsCommands(program, cliContext);

  program.hook('preAction', (_thisCommand, actionCommand) => {
    const logger = getOrCreateActionLogger(actionCommand);
    if (!logger.enabled) {
      return;
    }

    const commandPath = commandPathFor(actionCommand);
    const startedAt = Date.now();
    actionStartByCommand.set(actionCommand, startedAt);
    activeAction = {
      commandPath,
      startedAt
    };
    if (actionLogVerbose) {
      logger.log('command.start', {
        commandPath,
        argv: sanitizeArgvForLog(argvForCommand(actionCommand)),
        args: actionCommand.args,
        options: actionCommand.optsWithGlobals()
      });
      return;
    }

    logger.log('command.start', {
      commandPath
    });
  });

  program.hook('postAction', (_thisCommand, actionCommand) => {
    const logger = getOrCreateActionLogger(actionCommand);
    if (!logger.enabled) {
      return;
    }

    const commandPath = commandPathFor(actionCommand);
    const startedAt = actionStartByCommand.get(actionCommand) ?? Date.now();
    const durationMs = Date.now() - startedAt;

    actionStartByCommand.delete(actionCommand);
    if (activeAction?.commandPath === commandPath) {
      activeAction = undefined;
    }

    logger.log('command.complete', {
      commandPath,
      durationMs,
      exitCode: process.exitCode ?? 0
    });
  });

  (program as CliProgramWithActionLogState)[CLI_ACTION_LOG_STATE] = () => ({
    logger: actionLogger,
    activeAction,
    verbose: actionLogVerbose
  });

  program.exitOverride((error) => {
    if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') {
      return;
    }
    throw error;
  });

  program.configureOutput({
    writeErr: (text: string) => {
      stderr.write(text);
    }
  });

  return program;
}

export async function runCli(argv = process.argv, runtime: CliRuntime = {}): Promise<void> {
  const program = createCli(runtime);
  const stateReader = (program as CliProgramWithActionLogState)[CLI_ACTION_LOG_STATE];

  try {
    await program.parseAsync(argv);
  } catch (error) {
    const state = stateReader?.();
    if (state?.logger?.enabled) {
      const activeAction = state.activeAction;
      const verbose = state.verbose === true;
      const baseErrorPayload: Record<string, unknown> = {
        commandPath: activeAction?.commandPath ?? inferCommandPathFromArgv(argv),
        durationMs: activeAction ? Date.now() - activeAction.startedAt : undefined
      };

      if (verbose) {
        // inferCommandPathFromArgv expects full process-style argv, but logged argv should exclude runtime/executable tokens.
        baseErrorPayload.argv = sanitizeArgvForLog(argv.slice(2));
        baseErrorPayload.error = toProblemDetails(error);
      } else {
        baseErrorPayload.error = errorMessage(error);
      }

      state.logger.log('command.error', baseErrorPayload, 'error');
    }
    throw error;
  } finally {
    stateReader?.().logger?.close();
  }
}
