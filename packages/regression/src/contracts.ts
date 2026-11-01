import { z } from 'zod';
import { eventSchema, id, outcomeSchema, policySchema } from '../../contracts/src/index.ts';
import type { Assessment } from '../../contracts/src/index.ts';
import type { FrozenRun } from '../../evaluation/src/index.ts';

export const expectedBehaviorSchema = z.object({
  kind: z.enum(['completion', 'honest_failure', 'escalation']),
  description: z.string().min(3).max(5000),
  executionStatuses: z.array(z.enum(['completed', 'failed', 'cancelled', 'abandoned'])).min(1).max(4),
  messageIncludes: z.array(z.string().min(1).max(1000)).max(12).default([]),
  outcomes: z.array(z.object({ id, verification: z.enum(['verified', 'contradicted']) }).strict()).max(50).default([]),
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'completion' && value.executionStatuses.some(status => status !== 'completed'))
    ctx.addIssue({ code: 'custom', path: ['executionStatuses'], message: 'Completion requires completed execution.' });
  if (value.kind === 'completion' && value.outcomes.some(outcome => outcome.verification !== 'verified'))
    ctx.addIssue({ code: 'custom', path: ['outcomes'], message: 'Completion outcome assertions must require verified outcomes.' });
  if (value.kind !== 'completion' && !value.messageIncludes.length)
    ctx.addIssue({ code: 'custom', path: ['messageIncludes'], message: 'Failure and escalation expectations need an explicit acknowledgement phrase.' });
  if (new Set(value.outcomes.map(outcome => outcome.id)).size !== value.outcomes.length)
    ctx.addIssue({ code: 'custom', path: ['outcomes'], message: 'Outcome assertion IDs must be unique.' });
});
export type ExpectedBehavior = z.infer<typeof expectedBehaviorSchema>;

const evidenceSchema = z.object({
  id: z.string(), outcomeId: z.string(), source: z.enum(['provider_observation', 'customer_verifier', 'reported_tool_result']),
  provider: z.string(), observedAt: z.string().datetime({ offset: true }), resourceId: z.string(),
  properties: z.record(z.string(), z.unknown()), status: z.enum(['observed', 'unavailable']), reason: z.string().optional(),
});
export const frozenRunSchema = z.object({
  id, revision: z.number().int().positive(), executionStatus: z.enum(['running', 'completed', 'failed', 'cancelled', 'abandoned']),
  startedAt: z.string().datetime({ offset: true }), completedAt: z.string().datetime({ offset: true }).nullable(),
  events: z.array(eventSchema).max(10000), evidence: z.array(evidenceSchema).max(10000), policy: policySchema,
  calibrationApproved: z.boolean().optional(), observationsCollected: z.boolean().optional(),
}).passthrough();
const sourceSchema = z.object({
  reviewId: z.uuid(), reviewDecisionId: z.uuid(), evaluationId: z.uuid(), runId: id, revision: z.number().int().positive(),
  policyId: z.uuid(), policyHash: z.string().min(1), environment: z.enum(['production', 'staging', 'test']),
  provenance: z.array(z.string().max(500)).max(20),
});
const humanReviewSchema = z.object({
  decision: z.enum(['pass', 'fail']), annotation: z.string().min(3), reviewerId: z.uuid(),
  decidedAt: z.string().datetime({ offset: true }), version: z.number().int().positive(),
});
export const semanticGateSchema = z.object({ policyActivated: z.boolean(), calibrationApproved: z.boolean(), detectorHash: z.string(), reportId: z.uuid().optional() });
const caseBase = z.object({
  id, source: sourceSchema, humanReview: humanReviewSchema, traceHash: z.string().regex(/^[a-f0-9]{64}$/),
  frozenInput: frozenRunSchema, providerResponse: z.unknown().nullable(), expectations: z.array(outcomeSchema), semanticGate: semanticGateSchema,
});
export const regressionCaseSchema = caseBase.extend({ expectedBehavior: expectedBehaviorSchema }).strict();
export const calibrationCaseSchema = caseBase.extend({ humanLabel: z.enum(['violation', 'clear']), stratum: z.string().min(1).max(160) }).strict();
export type RegressionCase = z.infer<typeof regressionCaseSchema>;
export type CalibrationCase = z.infer<typeof calibrationCaseSchema>;
export type DatasetCase = RegressionCase | CalibrationCase;

const publishCase = z.object({ reviewId: z.uuid(), reviewVersion: z.number().int().positive(), caseId: id.optional() });
const publishBase = z.object({ projectId: z.uuid(), name: z.string().trim().min(1).max(160) });
export const publishDatasetSchema = z.discriminatedUnion('kind', [
  publishBase.extend({ kind: z.literal('agent_regression'), cases: z.array(publishCase.extend({ expectedBehavior: expectedBehaviorSchema }).strict()).min(1).max(500) }).strict(),
  publishBase.extend({ kind: z.literal('evaluator_calibration'), cases: z.array(publishCase.extend({ humanLabel: z.enum(['violation', 'clear']), stratum: z.string().min(1).max(160) }).strict()).min(1).max(500) }).strict(),
]);
export type Dataset = {
  id: string; name: string; kind: 'agent_regression' | 'evaluator_calibration'; version: number; hash: string;
  cases: DatasetCase[]; createdAt: string;
};
export const runMappingSchema = z.object({ caseId: id, runId: id, evaluationId: z.uuid().optional() }).strict();
export const candidateSchema = z.object({ name: z.string().min(1).max(120), runs: z.array(runMappingSchema).min(1).max(500) }).strict();
export const experimentSchema = z.object({
  projectId: z.uuid(), name: z.string().trim().min(1).max(160), datasetId: z.uuid(), datasetHash: z.string().length(64).optional(),
  policyId: z.uuid(), policyHash: z.string().min(1).optional(), candidates: z.array(candidateSchema).min(1).max(8),
  allowRequiredUnknown: z.boolean().default(false), evaluateMissing: z.boolean().default(true),
}).strict();
export type CandidateSpec = z.infer<typeof candidateSchema>;
export type PinnedCandidate = { name: string; runs: { caseId: string; runId: string; revision: number; evaluationId?: string }[] };
export type SemanticGate = z.infer<typeof semanticGateSchema>;
export type ExperimentSnapshot = {
  schemaVersion: '1.0'; datasetHash: string; policyHash: string; semanticGate: SemanticGate;
  allowRequiredUnknown: boolean; candidates: PinnedCandidate[];
};
export type EvaluationSnapshot = {
  id: string; runId: string; revision: number; policyId: string; policyHash: string; processing: string;
  frozenInput: FrozenRun | null; providerResponse: unknown; completedAt: string | null;
};
export type AssertionResult = { code: string; status: 'pass' | 'fail' | 'unknown' | 'allowed'; message: string };
export type CaseReport = {
  caseId: string; runId: string; revision: number; evaluationId: string | null; expectedBehavior: ExpectedBehavior;
  executionStatus: string | null; qualityDecision: Assessment['decision'] | null;
  verification: 'verified' | 'contradicted' | 'unknown' | 'not_required'; status: ReportStatus;
  requiredUnknown: number; semanticReviewOnly: number; assertions: AssertionResult[];
  findings: Assessment['findings']; limitations: string[];
};
export type ReportStatus = 'passed' | 'failed' | 'indeterminate';
export type Summary = { cases: number; passed: number; failed: number; indeterminate: number; requiredUnknown: number; semanticReviewOnly: number };
export type ComparisonReport = {
  schemaVersion: '1.0'; experimentId: string; projectId: string; name: string; createdAt: string; generatedAt: string;
  dataset: { id: string; name: string; kind: 'agent_regression'; version: number; hash: string };
  policy: { id: string; version: number; name: string; hash: string; semanticGate: SemanticGate };
  allowRequiredUnknown: boolean; ready: boolean; status: ReportStatus; exitCode: 0 | 1 | 2; summary: Summary;
  candidates: { name: string; status: ReportStatus; summary: Summary; cases: CaseReport[] }[];
  historicalReplay: true; customerCodeExecuted: false; externalRequestsRepeated: false;
};
