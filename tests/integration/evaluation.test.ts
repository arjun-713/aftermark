import { afterAll,expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pool,tenant,rows,sql } from '@agent-quality/db';
import { defaultPolicy } from '@agent-quality/contracts';
import { ingest } from '../../apps/api/src/ingestion.ts';
import { evaluateJob } from '../../apps/worker/src/evaluate.ts';
import { makeFrozen } from '../fixtures/evaluation.ts';
import { queue,stopQueue,type RunJob } from '../../packages/db/src/queue.ts';
const org='10000000-0000-4000-8000-000000000001',project='20000000-0000-4000-8000-000000000001';
afterAll(async()=>{await stopQueue();await pool.end();});
async function setup(semantic=false):Promise<RunJob>{
  await queue();const runId=`evaluation-${randomUUID()}`;const input=makeFrozen();input.events=input.events.map(e=>({...e,eventId:`${runId}-${e.eventId}`,runId}));
  await ingest({organizationId:org,projectId:project,userId:null,role:'member',scopes:['ingest']},project,input.events);
  const policy=semantic?{...defaultPolicy,semanticEnabled:true,checks:[{id:'claim',type:'completion_claim',primitive:'noul',instructions:'Does the final response claim completion?',threshold:0.95,blocking:false}]}:defaultPolicy;
  const policyId=randomUUID();
  await tenant(org,null,async tx=>{await tx.execute(sql`select id from projects where id=${project} for update`);const [{version}]=await rows<any>(tx,sql`select max(version)+1 as version from policies where project_id=${project}`);await tx.execute(sql`insert into policies(organization_id,project_id,id,version,definition,hash) values(${org},${project},${policyId},${version},${JSON.stringify(policy)}::jsonb,'test-policy-hash')`);await tx.execute(sql`insert into evidence(organization_id,project_id,run_id,body) values(${org},${project},${runId},${JSON.stringify(input.evidence[0])}::jsonb)`);});
  return {organizationId:org,projectId:project,runId,revision:1,policyId,explicit:true};
}
it('freezes a revision and charges a successful evaluation once under duplicate jobs',async()=>{
  const job=await setup();const first=await evaluateJob(job);expect(first.assessment?.decision).toBe('pass');await evaluateJob(job);
  const usage=await tenant(org,null,tx=>rows<any>(tx,sql`select l.state,l.units,e.frozen_input from usage_ledger l join evaluations e on e.organization_id=l.organization_id and e.project_id=l.project_id and e.id=l.evaluation_id where e.run_id=${job.runId}`));expect(usage).toHaveLength(1);expect(usage[0].state).toBe('consumed');expect(usage[0].frozen_input.revision).toBe(1);
});
it('retains ambiguous reservations after a terminated worker and never repeats the model request',async()=>{
  const job=await setup(true);
  const child=spawn(process.execPath,['--import','tsx','tests/fixtures/crash-worker.ts'],{cwd:process.cwd(),env:{...process.env,AQ_TEST_JOB:JSON.stringify(job)},stdio:['ignore','pipe','pipe']});
  let output='';
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Worker never reached provider boundary')),15000);child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('provider-call-started')){clearTimeout(timer);resolve();}});child.on('exit',code=>{clearTimeout(timer);reject(new Error(`Worker exited early: ${code}`));});});
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  let calls=0;const recovered=await evaluateJob(job,{semanticTransport:async()=>{calls++;throw new Error('Must not repeat');}});expect(calls).toBe(0);expect(recovered.assessment?.decision).toBe('unknown');
  const [ledger]=await tenant(org,null,tx=>rows<any>(tx,sql`select l.state from usage_ledger l join evaluations e on e.organization_id=l.organization_id and e.project_id=l.project_id and e.id=l.evaluation_id where e.run_id=${job.runId}`));expect(ledger.state).toBe('ambiguous');
});
