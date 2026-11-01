import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Assessment } from '../../contracts/src/index.ts';

export const alertQueueName = 'deliver-project-alert';
export const alertDeadLetterQueue = 'project-alert-dead-letter';
export const alertLimits = Object.freeze({ destinations: 5, attempts: 5, replays: 3, replayCooldownSeconds: 60, dnsTimeoutMs: 3000, requestTimeoutMs: 8000 });
export const alertStates = ['pending','delivering','retrying','delivered','dead_letter','disabled'] as const;
export const alertJobSchema = z.object({ organizationId: z.uuid(), projectId: z.uuid(), deliveryId: z.uuid(), generation: z.number().int().nonnegative() }).strict();
export type AlertJob = z.infer<typeof alertJobSchema>;
export const alertPayloadSchema = z.object({
  schemaVersion: z.literal('1.0'), id: z.uuid(), type: z.literal('evaluation.completed'), createdAt: z.iso.datetime(),
  projectId: z.uuid(), evaluationId: z.uuid(), revision: z.number().int().positive(),
  processing: z.enum(['completed','partial','error']), quality: z.enum(['pass','fail','review','unknown']),
  verification: z.object({ verified: z.number().int().nonnegative(), contradicted: z.number().int().nonnegative(), unknown: z.number().int().nonnegative() }).strict(),
}).strict();
export type AlertPayload = z.infer<typeof alertPayloadSchema>;
export type AlertCompletion = { organizationId: string; projectId: string; evaluationId: string; revision: number; assessment: Pick<Assessment,'processing'|'decision'|'outcomes'> };
export function alertPayload(input: AlertCompletion, id: string, createdAt = new Date().toISOString()): AlertPayload {
  const verification = { verified: 0, contradicted: 0, unknown: 0 };
  for (const outcome of input.assessment.outcomes) verification[outcome.verification]++;
  return alertPayloadSchema.parse({ schemaVersion: '1.0', id, type: 'evaluation.completed', createdAt,
    projectId: input.projectId, evaluationId: input.evaluationId, revision: input.revision,
    processing: input.assessment.processing, quality: input.assessment.decision, verification });
}
export function signAlert(secret: string, timestamp: string, rawBody: string) {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
}
export function verifyAlert(secret: string, timestamp: string, rawBody: string, signature: string, now = Date.now()) {
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300 || !/^[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signAlert(secret, timestamp, rawBody), 'hex'), Buffer.from(signature, 'hex'));
}
export type AlertFailure = 'dns_rejected'|'dns_failed'|'timeout'|'transport_failed'|'tls_failed'|'http_4xx'|'http_5xx'|'redirect_rejected'|'secret_invalid';
export class AlertError extends Error { constructor(public code: AlertFailure, public statusCode?: number) { super(code); } }
