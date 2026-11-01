import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { pool, rows, sql, tenant } from '@agent-quality/db';
import { ingest } from '../../apps/api/src/ingestion.ts';
import { evaluateJob } from '../../apps/worker/src/evaluate.ts';
import { retryQuotaDeniedEvaluation } from '../../packages/evaluation/src/worker.ts';
import { ProviderError } from '../../packages/evaluation/src/jev.ts';
import { defaultPolicy, type Policy } from '../../packages/contracts/src/index.ts';
import { canonical } from '../../packages/contracts/src/redaction.ts';
import { queue, stopQueue, type RunJob } from '../../packages/db/src/queue.ts';
import { makeFrozen } from '../fixtures/evaluation.ts';

const org=randomUUID(),project=randomUUID(),user='00000000-0000-4000-8000-000000000001';
const policyId=randomUUID(),semanticPolicyId=randomUUID();
const semanticPolicy:Policy={...defaultPolicy,semanticEnabled:true,checks:[{id:'claim',type:'completion_claim',primitive:'noul',instructions:'Does the final response falsely claim completion?',threshold:0.95,blocking:false}]};
beforeAll(async()=>{
  expect(new URL(process.env.DATABASE_URL!).pathname).toBe('/aq_identity_test');await queue();
  await tenant(org,user,async tx=>{
    await tx.execute(sql`insert into organizations(id,name) values(${org},'Synthetic quota retry workspace')`);
    await tx.execute(sql`insert into memberships(organization_id,user_id,role) values(${org},${user},'owner')`);
    await tx.execute(sql`insert into subscriptions(organization_id,allowance) values(${org},0)`);
    await tx.execute(sql`insert into projects(organization_id,id,name) values(${org},${project},'Synthetic quota retry project')`);
    for(const [id,version,definition] of [[policyId,1,defaultPolicy],[semanticPolicyId,2,semanticPolicy]] as const)
      await tx.execute(sql`insert into policies(organization_id,project_id,id,version,definition,hash) values(${org},${project},${id},${version},${JSON.stringify(definition)}::jsonb,${createHash('sha256').update(canonical(definition)).digest('hex')})`);
    await tx.execute(sql`update projects set active_policy_id=${policyId} where id=${project}`);
  });
});
afterAll(async()=>{await stopQueue();await pool.end();});
async function allowance(value:number) {await tenant(org,user,tx=>tx.execute(sql`update subscriptions set allowance=${value},status='trialing',period_start=now()-interval '1 day',period_end=now()+interval '10 days' where organization_id=${org}`));}
async function submitted(semantic=false):Promise<RunJob> {
  const runId=`retry-${randomUUID()}`,input=makeFrozen();
  input.events=input.events.map(event=>({...event,eventId:`${runId}-${event.eventId}`,runId,payload:{...event.payload,metadata:{sample:true,provenance:'synthetic engineering fixture'}}}));
  input.events.find(event=>event.kind==='outcome.expected')!.payload.outcome!.source='customer_verifier';
  const evidence={...input.evidence[0],source:'customer_verifier',provider:'Synthetic signed-verifier fixture'};
  await ingest({organizationId:org,projectId:project,userId:user,role:'owner',scopes:[]},project,input.events);
  const [run]=await tenant(org,user,async tx=>{
    await tx.execute(sql`insert into evidence(organization_id,project_id,run_id,body) values(${org},${project},${runId},${JSON.stringify(evidence)}::jsonb)`);
    return rows<any>(tx,sql`select instance_id from runs where project_id=${project} and id=${runId}`);
  });
  return {organizationId:org,projectId:project,runId,instanceId:run.instance_id,revision:1,policyId:semantic?semanticPolicyId:policyId,explicit:true};
}
async function denied(semantic=false) {
  await allowance(0);const job=await submitted(semantic);const transport=vi.fn();const result=await evaluateJob(job,{semanticTransport:transport});
  expect(result.assessment?.processing).toBe('error');expect(result.assessment?.decision).toBe('unknown');expect(transport).not.toHaveBeenCalled();
  const [evaluation]=await tenant(org,user,tx=>rows<any>(tx,sql`select * from evaluations where project_id=${project} and id=${result.evaluationId}`));
  return {job,evaluation};
}
const retry=(evaluationId:string)=>tenant(org,user,tx=>retryQuotaDeniedEvaluation(tx,{organizationId:org,projectId:project,evaluationId,requestedBy:user}));
const state=(evaluationId:string)=>tenant(org,user,async tx=>({
  evaluations:await rows<any>(tx,sql`select * from evaluations where project_id=${project} and id=${evaluationId}`),
  usage:await rows<any>(tx,sql`select * from usage_ledger where project_id=${project} and evaluation_id=${evaluationId}`),
  attempts:await rows<any>(tx,sql`select * from evaluation_attempts where project_id=${project} and evaluation_id=${evaluationId} order by attempt_number`),
}));

describe('explicit quota-denial recovery',()=>{
  it('preserves the evaluation UUID and frozen input, records the old error, and consumes one restored unit',async()=>{
    const {job,evaluation}=await denied();const before=await state(evaluation.id);expect(before.usage).toHaveLength(0);await allowance(1000);
    const scheduled=await retry(evaluation.id);expect(scheduled.evaluationId).toBe(evaluation.id);expect(scheduled.attemptNumber).toBe(1);expect(scheduled.jobId).toBeTruthy();
    const pending=await state(evaluation.id);expect(pending.evaluations[0].frozen_input).toEqual(evaluation.frozen_input);expect(pending.evaluations[0].completed_at).toBeNull();expect(pending.evaluations[0].processing).toBe('pending');expect(pending.evaluations[0].assessment).toBeNull();expect(pending.evaluations[0].quota_retry_frozen).toBe(true);
    expect(pending.usage).toHaveLength(1);expect(pending.usage[0].state).toBe('reserved');expect(pending.attempts).toHaveLength(1);expect(pending.attempts[0].assessment).toEqual(evaluation.assessment);
    expect(pending.attempts[0].frozen_input_hash).toBe(createHash('sha256').update(canonical(evaluation.frozen_input)).digest('hex'));
    const transport=vi.fn(),collect=vi.fn(async()=>{throw new Error('Frozen retry must not collect new observations');});
    const result=await evaluateJob(job,{semanticTransport:transport,collectEvidence:collect});expect(result.evaluationId).toBe(evaluation.id);expect(result.assessment?.decision).toBe('pass');expect(transport).not.toHaveBeenCalled();expect(collect).not.toHaveBeenCalled();
    await evaluateJob(job,{semanticTransport:transport});const final=await state(evaluation.id);expect(final.evaluations).toHaveLength(1);expect(final.evaluations[0].frozen_input).toEqual(evaluation.frozen_input);expect(final.usage).toHaveLength(1);expect(final.usage[0].state).toBe('consumed');expect(final.usage[0].units).toBe(1);expect(final.attempts[0]).toEqual(pending.attempts[0]);
    await expect(tenant(org,user,tx=>tx.execute(sql`update evaluation_attempts set reason='quota_denied' where project_id=${project} and evaluation_id=${evaluation.id}`))).rejects.toMatchObject({cause:{code:'42501'}});
    await expect(tenant(org,user,tx=>tx.execute(sql`delete from evaluation_attempts where project_id=${project} and evaluation_id=${evaluation.id}`))).rejects.toMatchObject({cause:{code:'42501'}});
  });
  it('permits the first semantic request only after explicit recovery and never repeats it',async()=>{
    const {job,evaluation}=await denied(true);await allowance(1000);await retry(evaluation.id);
    const transport=vi.fn(async()=>({model:'jev-1.14.0',answers:{claim:{type:'noul',noul:0}},usage:{input_tokens:100,output_tokens:5}}));
    const result=await evaluateJob(job,{semanticTransport:transport});expect(result.evaluationId).toBe(evaluation.id);expect(result.assessment?.decision).toBe('pass');expect(transport).toHaveBeenCalledTimes(1);
    await expect(retry(evaluation.id)).rejects.toMatchObject({code:'retry_not_eligible'});await evaluateJob(job,{semanticTransport:transport});expect(transport).toHaveBeenCalledTimes(1);
    const stored=await state(evaluation.id);expect(stored.attempts).toHaveLength(1);expect(stored.usage).toHaveLength(1);expect(stored.usage[0].state).toBe('consumed');
  });
  it('does not reset an error while quota is still unavailable',async()=>{
    const {evaluation}=await denied();await expect(retry(evaluation.id)).rejects.toMatchObject({statusCode:402,code:'quota_unavailable'});
    const stored=await state(evaluation.id);expect(stored.evaluations[0]).toEqual(evaluation);expect(stored.usage).toHaveLength(0);expect(stored.attempts).toHaveLength(0);
  });
  it.each(['reserved','consumed','released','ambiguous'] as const)('rejects prior %s ledger history without resetting it',async ledgerState=>{
    const {evaluation}=await denied();await tenant(org,user,tx=>tx.execute(sql`insert into usage_ledger(organization_id,project_id,evaluation_id,state) values(${org},${project},${evaluation.id},${ledgerState})`));await allowance(1000);
    await expect(retry(evaluation.id)).rejects.toMatchObject({code:'retry_not_eligible'});const stored=await state(evaluation.id);expect(stored.usage[0].state).toBe(ledgerState);expect(stored.evaluations[0]).toEqual(evaluation);expect(stored.attempts).toHaveLength(0);
  });
  it.each(['partial','completed','processing'] as const)('rejects %s processing instead of treating it as quota denial',async processing=>{
    const {evaluation}=await denied();await tenant(org,user,tx=>tx.execute(sql`update evaluations set processing=${processing} where project_id=${project} and id=${evaluation.id}`));await allowance(1000);
    await expect(retry(evaluation.id)).rejects.toMatchObject({code:'retry_not_eligible'});const stored=await state(evaluation.id);expect(stored.evaluations[0].processing).toBe(processing);expect(stored.attempts).toHaveLength(0);expect(stored.usage).toHaveLength(0);
  });
  it.each([null,{model:'provider-processed'}])('rejects any stored provider JSON, including JSON null',async response=>{
    const {evaluation}=await denied();await tenant(org,user,tx=>tx.execute(sql`update evaluations set provider_response=${JSON.stringify(response)}::jsonb where project_id=${project} and id=${evaluation.id}`));await allowance(1000);
    await expect(retry(evaluation.id)).rejects.toMatchObject({code:'retry_not_eligible'});const stored=await state(evaluation.id);expect(stored.attempts).toHaveLength(0);expect(stored.usage).toHaveLength(0);
  });
  it('retains a genuinely ambiguous semantic reservation and never retries the request',async()=>{
    await allowance(1000);const job=await submitted(true);const transport=vi.fn(async()=>{throw new ProviderError('Synthetic ambiguous provider delivery.',true);});
    const result=await evaluateJob(job,{semanticTransport:transport});expect(result.assessment?.processing).toBe('partial');expect(transport).toHaveBeenCalledTimes(1);
    await expect(retry(result.evaluationId!)).rejects.toMatchObject({code:'retry_not_eligible'});await evaluateJob(job,{semanticTransport:transport});expect(transport).toHaveBeenCalledTimes(1);
    expect((await state(result.evaluationId!)).usage[0].state).toBe('ambiguous');
  });
  it('rejects superseded run revisions while retaining the original error history',async()=>{
    const {job,evaluation}=await denied();await tenant(org,user,tx=>tx.execute(sql`update runs set revision=2 where project_id=${project} and id=${job.runId}`));await allowance(1000);
    await expect(retry(evaluation.id)).rejects.toMatchObject({code:'retry_superseded'});expect((await state(evaluation.id)).attempts).toHaveLength(0);
  });
  it('serializes explicit recovery against restored quota capacity',async()=>{
    const first=await denied(),second=await denied();const [{used}]=await tenant(org,user,tx=>rows<any>(tx,sql`select coalesce(sum(units),0)::int as used from usage_ledger where state in('reserved','consumed','ambiguous')`));await allowance(used+1);
    const results=await Promise.allSettled([retry(first.evaluation.id),retry(second.evaluation.id)]);expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(results.find(result=>result.status==='rejected')).toMatchObject({reason:{code:'quota_unavailable'}});
    const states=await Promise.all([state(first.evaluation.id),state(second.evaluation.id)]);expect(states.reduce((sum,value)=>sum+value.attempts.length,0)).toBe(1);expect(states.reduce((sum,value)=>sum+value.usage.length,0)).toBe(1);
  });
  it('serializes duplicate explicit requests into one attempt and one reservation',async()=>{
    const {evaluation}=await denied();await allowance(1000);
    const results=await Promise.allSettled([retry(evaluation.id),retry(evaluation.id)]);expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(results.find(result=>result.status==='rejected')).toMatchObject({reason:{code:'retry_not_eligible'}});
    const stored=await state(evaluation.id);expect(stored.evaluations[0].frozen_input).toEqual(evaluation.frozen_input);expect(stored.usage).toHaveLength(1);expect(stored.usage[0].state).toBe('reserved');expect(stored.attempts).toHaveLength(1);
  });
});
