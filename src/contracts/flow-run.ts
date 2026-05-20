import { z } from 'zod';

import { FLOW_RUN_SCHEMA_VERSION } from './versions';

const FlowRunClassificationSchema = z.enum(['needs_data', 'bug']);
const FlowRunStepKindSchema = z.enum(['task', 'gate']);
const FlowRunStepStatusSchema = z.enum(['pending', 'completed', 'failed', 'gate_pending', 'gate_approved', 'skipped']);

const FlowRunProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int().optional(),
  detail: z.string(),
  instance: z.string().optional(),
  xyteCode: z.string(),
  retriable: z.boolean(),
  upstream: z.unknown().optional()
});

export const FlowRunStepSchema = z.object({
  stepId: z.string(),
  title: z.string(),
  kind: FlowRunStepKindSchema,
  command: z.string(),
  status: FlowRunStepStatusSchema,
  startedAtUtc: z.string().optional(),
  endedAtUtc: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  artifactPath: z.string().optional(),
  error: FlowRunProblemSchema.optional(),
  classification: FlowRunClassificationSchema.optional(),
  note: z.string().optional()
});

export const FlowRunDecisionSchema = z.object({
  timestamp: z.string(),
  stepId: z.string(),
  action: z.enum(['pending', 'approved', 'blocked']),
  detail: z.string().optional(),
  requiresWrite: z.boolean()
});

const FlowRunNextActionSchema = z.object({
  kind: z.enum(['approve_gate', 'provide_input', 'fix_failure']),
  stepId: z.string(),
  title: z.string(),
  requiresWrite: z.boolean(),
  artifactPaths: z.array(z.string()),
  command: z.string()
});

export const FlowRunErrorEntrySchema = z.object({
  timestamp: z.string(),
  stepId: z.string(),
  classification: FlowRunClassificationSchema,
  error: FlowRunProblemSchema
});

export const FlowRunSummarySchema = z.object({
  schemaVersion: z.literal(FLOW_RUN_SCHEMA_VERSION),
  generatedAtUtc: z.string(),
  runId: z.string(),
  flowId: z.string(),
  resolvedFlowId: z.string(),
  mode: z.enum(['plan', 'apply']),
  tenantId: z.string(),
  bundleDir: z.string(),
  manifestPath: z.string(),
  inputsPath: z.string(),
  decisionsPath: z.string(),
  errorsPath: z.string(),
  watchFramesPath: z.string(),
  startedAtUtc: z.string(),
  endedAtUtc: z.string(),
  durationMs: z.number().int().nonnegative(),
  resumeFrom: z.string().optional(),
  outcome: z.enum(['completed', 'pending_gate', 'needs_input', 'failed']),
  nextResumeStepId: z.string().optional(),
  resumeCommand: z.string().optional(),
  nextAction: FlowRunNextActionSchema.optional(),
  steps: z.array(FlowRunStepSchema),
  decisions: z.object({
    pending: z.number().int().nonnegative(),
    approved: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative()
  }),
  classifications: z.object({
    needs_data: z.number().int().nonnegative(),
    bug: z.number().int().nonnegative()
  }),
  cursor: z.object({
    nextStepIndex: z.number().int().nonnegative(),
    nextStepId: z.string().optional()
  })
});

export type FlowRunClassification = z.infer<typeof FlowRunClassificationSchema>;
export type FlowRunNextAction = z.infer<typeof FlowRunNextActionSchema>;
export type FlowRunStep = z.infer<typeof FlowRunStepSchema>;
export type FlowRunDecision = z.infer<typeof FlowRunDecisionSchema>;
export type FlowRunErrorEntry = z.infer<typeof FlowRunErrorEntrySchema>;
export type FlowRunSummary = z.infer<typeof FlowRunSummarySchema>;

export function buildFlowRunSummary(
  summary: Omit<FlowRunSummary, 'schemaVersion' | 'generatedAtUtc'> & { generatedAtUtc?: string }
): FlowRunSummary {
  return {
    schemaVersion: FLOW_RUN_SCHEMA_VERSION,
    generatedAtUtc: summary.generatedAtUtc ?? new Date().toISOString(),
    ...summary
  };
}
