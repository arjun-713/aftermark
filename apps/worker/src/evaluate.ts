import { randomUUID } from 'node:crypto';
import { tenant,rows,sql,pool } from '@agent-quality/db';
import { limits,type Evidence,type Assessment } from '@agent-quality/contracts';
import { assess,type FrozenRun,type SemanticResult } from '../../../packages/evaluation/src/index.ts';
import { requestJev,validateJevResponse,ProviderError } from '../../../packages/evaluation/src/jev.ts';
import type { RunJob } from '../../../packages/db/src/queue.ts';
import { detectorHash } from '../../../packages/evaluation/src/calibration.ts';

export type EvaluationHooks={collectEvidence?:(input:FrozenRun,job:RunJob)=>Promise<Evidence[]>;semanticTransport?:(input:FrozenRun)=>Promise<unknown>};
export async function evaluateJob(job:RunJob,hooks:EvaluationHooks={}) {
  const connection=await pool.connect();const lock=`${job.organizationId}:${job.projectId}:${job.runId}`;
  try{
    const result=await connection.query('select pg_try_advisory_lock(hashtextextended($1,0)) as acquired',[lock]);
    if(!result.rows[0].acquired)throw new Error('Another evaluation for this run is in progress');
    return await evaluateInternal(job,hooks);
  }finally{await connection.query('select pg_advisory_unlock(hashtextextended($1,0))',[lock]).catch(()=>{});connection.release();}
}
async function evaluateInternal(job:RunJob,hooks:EvaluationHooks={}) {
  const prepared=await tenant(job.organizationId,null,async tx=>{
    const [run]=await rows<any>(tx,sql`select * from runs where project_id=${job.projectId} and id=${job.runId} for update`);
    if(!run || run.expired_at || run.revision!==job.revision || !job.explicit && run.auto_evaluations>limits.automaticReevaluations)return null;
    const [project]=await rows<any>(tx,sql`select active_policy_id from projects where id=${job.projectId}`);
    const policyId=job.policyId??project.active_policy_id;
    const [policy]=await rows<any>(tx,sql`select * from policies where project_id=${job.projectId} and id=${policyId}`);if(!policy)return null;
    const [existing]=await rows<any>(tx,sql`select * from evaluations where project_id=${job.projectId} and run_id=${job.runId} and revision=${job.revision} and policy_id=${policyId} for update`);
    if(existing?.completed_at)return null;
    if(existing)return {evaluation:existing,input:existing.frozen_input as FrozenRun};
    const events=(await rows<any>(tx,sql`select event from events where project_id=${job.projectId} and run_id=${job.runId} order by event->>'timestamp',event_id`)).map(x=>x.event);
    const evidence=(await rows<any>(tx,sql`select id,body from evidence where project_id=${job.projectId} and run_id=${job.runId}`)).map(x=>({...x.body,id:x.id}));
    const reports=policy.definition.calibrationReportId?await rows<any>(tx,sql`select passed,detector_hash from calibration_reports where project_id=${job.projectId} and id=${policy.definition.calibrationReportId}`):[];
    const input:FrozenRun={id:run.id,revision:run.revision,executionStatus:run.execution_status,startedAt:new Date(run.started_at).toISOString(),completedAt:run.completed_at?new Date(run.completed_at).toISOString():null,events,evidence,policy:policy.definition,calibrationApproved:Boolean(reports[0]?.passed && reports[0].detector_hash===detectorHash(policy.definition))};
    const id=randomUUID();
    const [evaluation]=await rows<any>(tx,sql`insert into evaluations(organization_id,project_id,id,run_id,revision,policy_id,policy_hash,processing,frozen_input) values(${job.organizationId},${job.projectId},${id},${job.runId},${job.revision},${policy.id},${policy.hash},'processing',${JSON.stringify(input)}::jsonb) returning *`);
    if(!job.explicit)await tx.execute(sql`update runs set auto_evaluations=auto_evaluations+1 where project_id=${job.projectId} and id=${job.runId}`);
    return {evaluation,input};
  });
  if(!prepared)return {status:'superseded_or_complete'};
  const {evaluation}=prepared;let input=prepared.input;
  let providerResponse=evaluation.provider_response,semanticError:string|undefined;
  // Freeze provider observations once. Retries with a stored observation never repeat a provider query.
  if(hooks.collectEvidence && !evaluation.frozen_input.observationsCollected){
    const observations=await hooks.collectEvidence(input,job);
    input={...input,evidence:[...input.evidence,...observations]};
    await tenant(job.organizationId,null,async tx=>{
      for(const observation of observations)await tx.execute(sql`insert into evidence(organization_id,project_id,id,run_id,body) values(${job.organizationId},${job.projectId},${observation.id},${job.runId},${JSON.stringify(observation)}::jsonb) on conflict do nothing`);
      await tx.execute(sql`update evaluations set frozen_input=${JSON.stringify({...input,observationsCollected:true})}::jsonb where project_id=${job.projectId} and id=${evaluation.id}`);
    });
  }
  const reservation=await tenant(job.organizationId,null,async tx=>{
    const [subscription]=await rows<any>(tx,sql`select * from subscriptions where organization_id=${job.organizationId} for update`);
    const [existing]=await rows<any>(tx,sql`select * from usage_ledger where project_id=${job.projectId} and evaluation_id=${evaluation.id}`);if(existing)return existing;
    const [{used}]=await rows<any>(tx,sql`select coalesce(sum(units),0)::int as used from usage_ledger where state in('reserved','consumed','ambiguous') and created_at>=${subscription.period_start}`);
    if(!['active','trialing'].includes(subscription.status)||Date.parse(subscription.period_end)<=Date.now()||used>=subscription.allowance)return null;
    const [entry]=await rows<any>(tx,sql`insert into usage_ledger(organization_id,project_id,evaluation_id,state) values(${job.organizationId},${job.projectId},${evaluation.id},'reserved') on conflict do nothing returning *`);return entry;
  });
  let semantic:SemanticResult|undefined;
  if(!reservation)semanticError='The workspace evaluation allowance is exhausted or its subscription is inactive.';
  else if(input.policy.semanticEnabled && input.policy.checks.length){
    if(providerResponse){try{semantic=validateJevResponse(providerResponse,input.policy);}catch{semanticError='Stored provider answers did not satisfy the typed contract.';}}
    else if(reservation.state==='ambiguous')semanticError='An earlier provider request has an ambiguous outcome; it will not be sent again automatically.';
    else {
      // Commit ambiguity before the network call; a terminated worker cannot issue it twice.
      await tenant(job.organizationId,null,tx=>tx.execute(sql`update usage_ledger set state='ambiguous' where project_id=${job.projectId} and evaluation_id=${evaluation.id}`));
      try{
        providerResponse=await(hooks.semanticTransport??requestJev)(input);
        await tenant(job.organizationId,null,tx=>tx.execute(sql`update evaluations set provider_response=${JSON.stringify(providerResponse)}::jsonb where project_id=${job.projectId} and id=${evaluation.id}`));
        semantic=validateJevResponse(providerResponse,input.policy);
      }catch(error){semanticError=error instanceof ProviderError?error.message:'Provider answers failed type, range or cardinality validation.';
        if(error instanceof ProviderError && !error.ambiguous)await tenant(job.organizationId,null,tx=>tx.execute(sql`update usage_ledger set state='released' where project_id=${job.projectId} and evaluation_id=${evaluation.id}`));
      }
    }
  }
  let assessment=assess(input,semantic,semanticError);
  if(!reservation)assessment={...assessment,processing:'error',decision:'unknown',verifiedCompletion:false,limitations:[...assessment.limitations,semanticError!]};
  await tenant(job.organizationId,null,async tx=>{
    await tx.execute(sql`update evaluations set processing=${assessment.processing},assessment=${JSON.stringify(assessment)}::jsonb,completed_at=now() where project_id=${job.projectId} and id=${evaluation.id}`);
    if(reservation && (!input.policy.semanticEnabled || !input.policy.checks.length || semantic))await tx.execute(sql`update usage_ledger set state='consumed',tokens=${assessment.usage} where project_id=${job.projectId} and evaluation_id=${evaluation.id}`);
    await tx.execute(sql`update runs set latest_evaluation_id=${evaluation.id} where project_id=${job.projectId} and id=${job.runId} and revision=${job.revision}`);
    if(assessment.decision!=='pass')await tx.execute(sql`insert into reviews(organization_id,project_id,evaluation_id,run_id) values(${job.organizationId},${job.projectId},${evaluation.id},${job.runId}) on conflict do nothing`);
  });
  return {status:assessment.processing,evaluationId:evaluation.id,assessment};
}
