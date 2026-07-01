import { z } from 'zod';

import { compareSemver } from './semver';
import { UPGRADE_CHECK_SCHEMA_VERSION, UPGRADE_RESULT_SCHEMA_VERSION } from './versions';

export const UpgradeCheckSchema = z.object({
  schemaVersion: z.literal(UPGRADE_CHECK_SCHEMA_VERSION),
  generatedAtUtc: z.string(),
  packageName: z.string(),
  installChannel: z.enum(['npm', 'windows-msi']).optional(),
  currentVersion: z.string(),
  latestVersion: z.string(),
  upToDate: z.boolean(),
  recommendedCommand: z.string().nullable()
});

const UpgradeCommandSchema = z.object({
  command: z.string(),
  args: z.array(z.string())
});

const UpgradeVerifySchema = z.object({
  command: UpgradeCommandSchema,
  detectedVersion: z.string(),
  expectedVersion: z.string(),
  match: z.boolean()
});

const UpgradeSkillOutcomeSchema = z.object({
  scope: z.enum(['project', 'user']),
  agent: z.enum(['claude', 'copilot', 'codex']),
  rootDir: z.string(),
  targetDir: z.string(),
  status: z.enum(['installed', 'overwritten', 'skipped', 'failed']),
  error: z.string().optional()
});

const UpgradeSkillsSchema = z.object({
  scope: z.literal('user'),
  agents: z.array(z.enum(['claude', 'copilot', 'codex'])),
  force: z.literal(true),
  sourceDir: z.string(),
  outcomes: z.array(UpgradeSkillOutcomeSchema),
  failedCount: z.number().int().nonnegative()
});

export const UpgradeResultSchema = z.object({
  schemaVersion: z.literal(UPGRADE_RESULT_SCHEMA_VERSION),
  generatedAtUtc: z.string(),
  packageName: z.string(),
  installChannel: z.enum(['npm', 'windows-msi']).optional(),
  currentVersion: z.string(),
  latestVersion: z.string(),
  upToDateBefore: z.boolean(),
  updated: z.boolean(),
  updateCommand: UpgradeCommandSchema.optional(),
  verify: UpgradeVerifySchema,
  skills: UpgradeSkillsSchema,
  warnings: z.array(z.string())
});

export type UpgradeCheckV1 = z.infer<typeof UpgradeCheckSchema>;
export type UpgradeResultV1 = z.infer<typeof UpgradeResultSchema>;

export function buildUpgradeCheck(args: {
  packageName: string;
  installChannel?: 'npm' | 'windows-msi';
  recommendedCommand?: string;
  currentVersion: string;
  latestVersion: string;
}): UpgradeCheckV1 {
  const upToDate = compareSemver(args.currentVersion, args.latestVersion) >= 0;
  const installChannel = args.installChannel ?? 'npm';
  const recommendedCommand =
    args.recommendedCommand ??
    (installChannel === 'windows-msi'
      ? 'winget upgrade --id Xyte.XyteCLI --exact'
      : `npm install --global ${args.packageName}@latest`);
  return {
    schemaVersion: UPGRADE_CHECK_SCHEMA_VERSION,
    generatedAtUtc: new Date().toISOString(),
    packageName: args.packageName,
    installChannel,
    currentVersion: args.currentVersion,
    latestVersion: args.latestVersion,
    upToDate,
    recommendedCommand: upToDate ? null : recommendedCommand
  };
}
