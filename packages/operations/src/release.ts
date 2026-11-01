import { z } from 'zod';
export const releaseGates = ['automated', 'operations', 'calibration', 'providers', 'payments', 'recovery', 'load', 'security', 'pilots', 'paidLifecycle', 'budget'] as const;
export type ReleaseGate = typeof releaseGates[number];
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const releaseManifestSchema = z.object({ version: z.literal(1), releaseId: z.string().min(1), commit: z.string().regex(/^[a-f0-9]{40}$/),
  artifacts: z.array(z.object({ gate: z.enum(releaseGates), path: z.string().min(1), sha256: sha }).strict()) }).strict();
const measured = z.object({ version: z.literal(1), measuredAt: z.iso.datetime(), commit: z.string().regex(/^[a-f0-9]{40}$/),
  environment: z.enum(['ci', 'production-equivalent']), observer: z.string().min(3) });
const positive = z.number().positive(), count = z.number().int().nonnegative(), yes = z.literal(true), zero = z.literal(0);
export const gateSchemas: Record<ReleaseGate, z.ZodType> = {
  automated: measured.extend({ suites: z.array(z.object({ name: z.enum(['unit', 'integration', 'e2e']), tests: count.min(1), failed: zero, exitCode: zero })).length(3) }).refine(v => new Set(v.suites.map(s => s.name)).size === 3),
  operations: measured.extend({ environment: z.literal('production-equivalent'), health: yes, restart: yes, queueRecovery: yes, cleanup: yes, gracefulShutdown: yes, logRedaction: yes }),
  calibration: measured.extend({ humanLabelAttestation: yes, totalCases: count.min(400), holdoutCases: count.min(100), corpusHash: sha, holdoutHash: sha, sealedBeforeTuning: yes, truePositives: count, falsePositives: count })
    .refine(v => v.holdoutCases === v.totalCases / 4 && v.truePositives + v.falsePositives > 0 && v.truePositives + v.falsePositives <= v.holdoutCases && v.truePositives / (v.truePositives + v.falsePositives) >= 0.95, 'At least 95% high-severity precision on a sealed 25% holdout is required.'),
  providers: measured.extend({ environment: z.literal('production-equivalent'), providers: z.array(z.object({ provider: z.enum(['github','hubspot']), realSandbox: yes, readOnly: yes, existence: yes, changedProperties: yes, expiredPermissions: yes, staleObservation: yes, reauthorization: yes, evidenceHash: sha })).length(2) }).refine(v => new Set(v.providers.map(p => p.provider)).size === 2),
  payments: measured.extend({ environment: z.literal('production-equivalent'), provider: z.literal('dodo'), realSandbox: yes, forgedRejected: yes, duplicateIdempotent: yes, outOfOrderSafe: yes, checkout: yes, cancellation: yes, reactivation: yes, trialEnd: yes, overQuota: yes, evidenceHash: sha }),
  recovery: measured.extend({ environment: z.literal('production-equivalent'), source: z.literal('independent-singapore-backup'), region: z.literal('ap-southeast-1'), independentBucket: yes, encrypted: yes, checksumVerified: yes, authenticatedDecryption: yes, deletionJournalReapplied: yes, serviceRecoveryVerified: yes, backupAgeMs: count.max(21600000), restoreMs: positive.max(14400000), evidenceHash: sha }),
  load: measured.extend({ environment: z.literal('production-equivalent'), durationSeconds: positive.min(60), eventsPerSecond: positive.min(100), acceptedEvents: count.min(6000), errors: zero, droppedBatches: zero, pendingEvaluations: zero, ingestP95Ms: positive.max(500), queryP95Ms: positive.max(1000), evaluationP95Ms: positive.max(90000), sampleEvaluations: count.min(10), evaluated: count.min(10) }).refine(v => v.evaluated === v.sampleEvaluations && v.acceptedEvents >= v.durationSeconds * 100, 'Load sample counts and achieved rate must agree.'),
  security: measured.extend({ environment: z.literal('production-equivalent'), critical: zero, high: zero, tenantIsolation: yes, csrf: yes, scopedKeys: yes, callbacks: yes, ssrf: yes, archives: yes, logs: yes, independentReview: yes, evidenceHash: sha }),
  pilots: measured.extend({ environment: z.literal('production-equivalent'), teams: z.array(z.object({ workspaceHash: sha, consecutiveDays: count.min(14), realWorkflows: yes, reviewedOutcomes: count.min(1), evidenceHash: sha })).min(3) }).refine(v => new Set(v.teams.map(t => t.workspaceHash)).size >= 3),
  paidLifecycle: measured.extend({ environment: z.literal('production-equivalent'), realCustomer: yes, paid: yes, invoiceSettled: yes, cancellation: yes, reactivation: yes, quotaApplied: yes, noDuplicateCharges: yes, evidenceHash: sha }),
  budget: measured.extend({ environment: z.literal('production-equivalent'), monthlyEstimateUsd: positive.min(50), alertAtUsd: positive.max(120), independentMonitoringConfigured: yes, capacityOver150Approved: z.boolean(), sourceHash: sha }).refine(v => v.alertAtUsd <= v.monthlyEstimateUsd && (v.monthlyEstimateUsd <= 150 || v.capacityOver150Approved), 'Capacity above $150 needs explicit approval.'),
};
export function validateGate(gate: ReleaseGate, input: unknown, commit: string, now = new Date()) {
  const parsed = gateSchemas[gate].safeParse(input);
  if (!parsed.success) return { passed: false, reason: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
  const v = parsed.data as z.infer<typeof measured>;
  if (v.commit !== commit) return { passed: false, reason: 'Evidence belongs to a different commit.' };
  if (Date.parse(v.measuredAt) > now.getTime() + 60000 || now.getTime() - Date.parse(v.measuredAt) > 30 * 86400000) return { passed: false, reason: 'Evidence must be current and no older than 30 days.' };
  return { passed: true, reason: 'Persisted measured evidence satisfies this gate.' };
}
