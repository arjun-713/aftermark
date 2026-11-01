import { createHash } from 'node:crypto';
import { rows, sql, type Tx } from '@agent-quality/db';
import { enqueue } from '../../db/src/queue.ts';
import { canonical } from '../../contracts/src/redaction.ts';

export class EvaluationRetryError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}
function reject(condition: unknown, status: number, code: string, message: string): asserts condition {
  if (!condition) throw new EvaluationRetryError(status, code, message);
}

/** Explicit API action only. Call inside tenant(); let any error roll back that transaction.
 * This never retries an ambiguous/provider-touched evaluation. The existing worker consumes the
 * new reserved ledger entry and reuses the unchanged frozen input and evaluation UUID.
 */
export async function retryQuotaDeniedEvaluation(tx: Tx, request: {
  organizationId: string; projectId: string; evaluationId: string; requestedBy: string | null;
}) {
  const { organizationId, projectId, evaluationId, requestedBy } = request;
  const [reference] = await rows<any>(tx, sql`select run_id,run_instance_id from evaluations where organization_id=${organizationId} and project_id=${projectId} and id=${evaluationId}`);
  reject(reference, 404, 'evaluation_not_found', 'Evaluation not found.');
  // Match the worker lock order: run first, then evaluation, then subscription.
  const [run] = await rows<any>(tx, sql`select id,instance_id,revision,expired_at from runs where organization_id=${organizationId} and project_id=${projectId} and id=${reference.run_id} for update`);
  const [evaluation] = await rows<any>(tx, sql`select *,provider_response is null as provider_response_absent from evaluations where organization_id=${organizationId} and project_id=${projectId} and id=${evaluationId} for update`);
  reject(run && evaluation && !run.expired_at && run.instance_id === evaluation.run_instance_id && run.revision === evaluation.revision,
    409, 'retry_superseded', 'The frozen evaluation no longer matches the current unexpired run instance and revision. Evaluate the current run instead.');
  const [ledger] = await rows(tx, sql`select evaluation_id from usage_ledger where organization_id=${organizationId} and project_id=${projectId} and evaluation_id=${evaluationId}`);
  reject(evaluation.processing === 'error' && evaluation.completed_at && evaluation.assessment?.processing === 'error' && evaluation.assessment?.decision === 'unknown' &&
    evaluation.frozen_input && evaluation.provider_response_absent && !ledger,
    409, 'retry_not_eligible', 'Only a completed quota-denied error with no provider response and no usage ledger history can be retried.');
  const frozen = evaluation.frozen_input;
  reject(typeof frozen === 'object' && !Array.isArray(frozen) && frozen.id === run.id && frozen.revision === evaluation.revision && (!frozen.runInstanceId || frozen.runInstanceId === run.instance_id),
    409, 'retry_identity_conflict', 'The frozen input does not match the evaluation identity.');
  const [subscription] = await rows<any>(tx, sql`select status,allowance,period_start,period_end from subscriptions where organization_id=${organizationId} for update`);
  const now = Date.now();
  reject(subscription && ['active', 'trialing'].includes(subscription.status) && Date.parse(subscription.period_start) <= now && Date.parse(subscription.period_end) > now,
    402, 'quota_unavailable', 'Restore an active subscription and evaluation allowance before retrying.');
  const [{ used }] = await rows<any>(tx, sql`select coalesce(sum(units),0)::int as used from usage_ledger where organization_id=${organizationId} and state in('reserved','consumed','ambiguous') and created_at>=${subscription.period_start} and created_at<${subscription.period_end}`);
  reject(used < subscription.allowance, 402, 'quota_unavailable', 'The restored evaluation allowance is still exhausted.');
  const [{ attempt }] = await rows<any>(tx, sql`select coalesce(max(attempt_number),0)+1 as attempt from evaluation_attempts where organization_id=${organizationId} and project_id=${projectId} and evaluation_id=${evaluationId}`);
  const inputHash = createHash('sha256').update(canonical(frozen)).digest('hex');
  await tx.execute(sql`insert into evaluation_attempts(organization_id,project_id,evaluation_id,attempt_number,reason,processing,assessment,frozen_input_hash,policy_hash,completed_at,requested_by)
    select organization_id,project_id,id,${attempt},'quota_denied',processing,assessment,${inputHash},policy_hash,completed_at,${requestedBy}
    from evaluations where organization_id=${organizationId} and project_id=${projectId} and id=${evaluationId}`);
  await tx.execute(sql`insert into usage_ledger(organization_id,project_id,evaluation_id,state) values(${organizationId},${projectId},${evaluationId},'reserved')`);
  await tx.execute(sql`update evaluations set processing='pending',assessment=null,completed_at=null,quota_retry_frozen=true where organization_id=${organizationId} and project_id=${projectId} and id=${evaluationId}`);
  const jobId = await enqueue(tx, { organizationId, projectId, runId: run.id, instanceId: run.instance_id, revision: evaluation.revision, policyId: evaluation.policy_id, explicit: true }, 0);
  // A queue policy can refuse a conflicting singleton. Never leave a reset evaluation
  // without durable queued work; the surrounding transaction rolls back on this error.
  reject(jobId, 409, 'retry_job_conflict', 'The previous evaluation job is still active. Retry after it finishes.');
  return { evaluationId, jobId, attemptNumber: attempt as number, runInstanceId: run.instance_id as string, processing: 'pending' as const };
}
