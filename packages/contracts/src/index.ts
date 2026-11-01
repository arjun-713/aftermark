import { z } from 'zod';

export const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
export const roles = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = typeof roles[number];
export const qualityDecisions = ['pass', 'fail', 'review', 'unknown'] as const;
export const executionStatuses = ['running', 'completed', 'failed', 'cancelled', 'abandoned'] as const;
export const assertionsSchema = z.record(z.string().min(1).max(120), z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]));
export const outcomeSchema = z.object({
  id, name: z.string().min(1).max(200), operation: z.enum(['github.issue.create', 'hubspot.contact.update', 'custom']),
  required: z.boolean().default(true), source: z.enum(['github', 'hubspot', 'customer_verifier']),
  resource: z.object({ id: z.string().max(256).optional(), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(), toolResultField: z.string().max(120).optional() }),
  assertions: assertionsSchema, observationWindowSeconds: z.number().int().min(1).max(86400).default(300)
}).strict();
export type Outcome = z.infer<typeof outcomeSchema>;
export const eventSchema = z.object({
  schemaVersion: z.literal('1.0'), eventId: id, runId: id, spanId: id.optional(), parentSpanId: id.optional(),
  kind: z.enum(['run.started', 'run.completed', 'run.failed', 'run.cancelled', 'span.started', 'span.completed', 'tool.called', 'tool.result', 'outcome.expected', 'message']),
  timestamp: z.string().datetime({ offset: true }), agentVersion: z.string().min(1).max(120), environment: z.enum(['production', 'staging', 'test']),
  payload: z.object({
    agent: z.string().max(160).optional(), name: z.string().max(160).optional(), text: z.string().max(32000).optional(),
    success: z.boolean().optional(), toolCallId: id.optional(), tool: z.string().max(160).optional(),
    arguments: z.record(z.string(), z.unknown()).optional(), result: z.record(z.string(), z.unknown()).optional(),
    outcome: outcomeSchema.optional(), metadata: z.record(z.string(), z.unknown()).optional()
  }).strict()
}).strict().superRefine((event, ctx) => {
  if (event.kind === 'outcome.expected' && !event.payload.outcome) ctx.addIssue({ code:'custom', message:'Expected outcome is required', path:['payload','outcome'] });
  if (event.kind === 'tool.result' && (typeof event.payload.success !== 'boolean' || !event.payload.toolCallId || !event.payload.tool)) ctx.addIssue({ code:'custom', message:'Tool results require tool, toolCallId and success', path:['payload'] });
});
export type AgentEvent = z.infer<typeof eventSchema>;
export const eventBatchSchema = z.object({ projectId: z.uuid(), events: z.array(eventSchema).min(1).max(100) }).strict();
export const policySchema = z.object({
  name: z.string().min(1).max(160), semanticEnabled: z.boolean().default(false), semanticBlocking: z.boolean().default(false),
  calibrationReportId: z.uuid().optional(), checks: z.array(z.object({
    id, type: z.enum(['completion_claim', 'failure_acknowledged', 'repetition', 'requirement']),
    instructions: z.string().min(5).max(2000), primitive: z.enum(['choice', 'score', 'noul']).default('noul'),
    threshold: z.number().min(0.5).max(1).default(0.95), blocking: z.boolean().default(false)
  }).strict()).max(12).default([]),
  toolMappings: z.array(z.object({ tool: z.string().min(1).max(160), outcome: outcomeSchema })).max(12).default([])
}).strict();
export type Policy = z.infer<typeof policySchema>;
export const defaultPolicy: Policy = { name: 'Outcome verification', semanticEnabled: false, semanticBlocking: false, checks: [], toolMappings: [] };
export const receiptSchema = z.object({
  receiptId: id, projectId: z.uuid(), runId: id, outcomeId: id, observedAt: z.string().datetime({ offset:true }),
  resourceId: z.string().min(1).max(256), properties: assertionsSchema, status: z.enum(['observed', 'unavailable'])
}).strict();
export type Evidence = {
  id: string; outcomeId: string; source: 'provider_observation' | 'customer_verifier' | 'reported_tool_result';
  provider: string; observedAt: string; resourceId: string; properties: Record<string, unknown>; status: 'observed' | 'unavailable';
  reason?: string;
};
export type Finding = { id: string; code: string; severity: 'high' | 'medium' | 'info'; summary: string; evidenceIds: string[]; outcomeId?: string; blocking: boolean; probability?: number };
export type Assessment = {
  rulesVersion: string;
  processing: 'completed' | 'partial' | 'error'; decision: typeof qualityDecisions[number];
  outcomes: { id: string; name: string; required: boolean; verification: 'verified' | 'contradicted' | 'unknown'; evidenceIds: string[]; reason: string }[];
  findings: Finding[]; limitations: string[]; verifiedCompletion: boolean; model: string | null; usage: number;
};
export const limits = { batchEvents: 100, batchBytes: 1048576, checks: 12, contextTokens: 16000, automaticReevaluations: 3 };
export const plans = { trial: { price:0, allowance:1000, projects:1, members:3 }, starter:{ price:29, allowance:10000, projects:3, members:3 }, team:{ price:99, allowance:50000, projects:20, members:10 } } as const;
