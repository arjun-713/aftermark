import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tenant, rows, sql, pool } from '@agent-quality/db';
import { defaultPolicy, type ConnectionBinding } from '../../packages/contracts/src/index.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { ingest } from '../../apps/api/src/ingestion.ts';
import { evaluateJob } from '../../apps/worker/src/evaluate.ts';
import { connectionToken } from '../../packages/integrations/src/providers.ts';
import { decrypt } from '../../packages/integrations/src/encryption.ts';
import { queue, stopQueue, enqueue } from '../../packages/db/src/queue.ts';
import { contentHash, datasetHash, frozenRunSchema, type RegressionCase } from '../../packages/regression/src/index.ts';
import { assess, expectedOutcomes, type FrozenRun } from '../../packages/evaluation/src/index.ts';
import { detectorHash } from '../../packages/evaluation/src/calibration.ts';
import { bindProviderFixture } from '../fixtures/provider-connection.ts';
import { makeFrozen } from '../fixtures/evaluation.ts';

const org='10000000-0000-4000-8000-000000000001',user='00000000-0000-4000-8000-000000000001',project=randomUUID(),policyId=randomUUID();
const app=await buildServer();let headers:Record<string,string>,sourceRun:string,sourceEvaluationId:string,datasetId:string;
const policyHash=contentHash(defaultPolicy);
function trace(runId:string):FrozenRun {
  const input=makeFrozen();const shift=Date.now()-1000-Date.parse(input.completedAt!);input.id=runId;
  input.startedAt=new Date(Date.parse(input.startedAt)+shift).toISOString();input.completedAt=new Date(Date.parse(input.completedAt!)+shift).toISOString();
  input.events=input.events.map(event=>({...event,runId,eventId:`${runId}-${event.eventId}`,timestamp:new Date(Date.parse(event.timestamp)+shift).toISOString(),payload:{...event.payload,metadata:{sample:true,provenance:'synthetic engineering fixture'}}}));
  input.evidence[0].observedAt=new Date().toISOString();return input;
}
async function submitted(runId=`identity-${randomUUID()}`,observed=true) {
  const input=trace(runId);await ingest({organizationId:org,projectId:project,userId:user,role:'owner',scopes:[]},project,input.events);
  await tenant(org,user,async tx=>{
    await bindProviderFixture(tx,org,project,input);const [run]=await rows<any>(tx,sql`select instance_id from runs where project_id=${project} and id=${runId}`);input.runInstanceId=run.instance_id;
    if(observed)await tx.execute(sql`insert into evidence(organization_id,project_id,run_id,body) values(${org},${project},${runId},${JSON.stringify(input.evidence[0])}::jsonb)`);
  });return input;
}
const job=(input:FrozenRun)=>({organizationId:org,projectId:project,runId:input.id,instanceId:input.runInstanceId,revision:1,policyId,explicit:true});
async function compare(runId:string,evaluateMissing=false) {return app.inject({method:'POST',url:'/v1/experiments',headers,payload:{projectId:project,name:'Immutable instance comparison',datasetId,policyId,candidates:[{name:'candidate',runs:[{caseId:'case',runId}]}],evaluateMissing}});}

beforeAll(async()=>{
  expect(new URL(process.env.DATABASE_URL!).pathname).toBe('/aq_identity_test');await queue();
  await tenant(org,user,async tx=>{
    await tx.execute(sql`insert into projects(organization_id,id,name) values(${org},${project},'Synthetic identity verification project')`);
    await tx.execute(sql`insert into policies(organization_id,project_id,id,version,definition,hash) values(${org},${project},${policyId},1,${JSON.stringify(defaultPolicy)}::jsonb,${policyHash})`);
    await tx.execute(sql`update projects set active_policy_id=${policyId} where id=${project}`);
  });
  const login=await app.inject({method:'POST',url:'/v1/auth/login',payload:{email:'alex@example.test',password:'local-password-123'}});expect(login.statusCode).toBe(200);
  headers={cookie:login.cookies.map(cookie=>`${cookie.name}=${cookie.value}`).join('; '),'x-workspace-id':org};
  const input=await submitted();sourceRun=input.id;const result=await evaluateJob(job(input));expect(result.assessment?.decision).toBe('pass');sourceEvaluationId=result.evaluationId!;
  const [storedSource]=await tenant(org,user,tx=>rows<any>(tx,sql`select frozen_input from evaluations where project_id=${project} and id=${sourceEvaluationId}`));const frozen=frozenRunSchema.parse(storedSource.frozen_input);
  const caseValue:RegressionCase={id:'case',source:{reviewId:randomUUID(),reviewDecisionId:randomUUID(),evaluationId:sourceEvaluationId,runId:input.id,revision:1,policyId,policyHash,environment:'test',provenance:['synthetic engineering fixture']},
    humanReview:{decision:'pass',annotation:'Synthetic test label; not human calibration evidence.',reviewerId:user,decidedAt:new Date().toISOString(),version:2},
    traceHash:contentHash(frozen),frozenInput:frozen,providerResponse:null,expectations:expectedOutcomes(frozen),semanticGate:{policyActivated:true,calibrationApproved:false,detectorHash:detectorHash(defaultPolicy)},
    expectedBehavior:{kind:'completion',description:'Verify the synthetic issue properties.',executionStatuses:['completed'],messageIncludes:[],outcomes:[]}};
  const cases=[caseValue],name='Synthetic instance dataset',kind='agent_regression';const hash=datasetHash({name,kind,version:1,cases});
  [datasetId]=await tenant(org,user,async tx=>(await rows<any>(tx,sql`insert into datasets(organization_id,project_id,name,kind,version,cases,hash) values(${org},${project},${name},${kind},1,${JSON.stringify(cases)}::jsonb,${hash}) returning id`)).map(row=>row.id));
});
afterAll(async()=>{await app.close();await stopQueue();await pool.end();});

describe('frozen verification and provider account versions',()=>{
  it('preserves bound evidence through dataset publication parsing and historical replay',async()=>{
    const [evaluation]=await tenant(org,user,tx=>rows<any>(tx,sql`select frozen_input from evaluations where project_id=${project} and id=${sourceEvaluationId}`));
    const parsed=frozenRunSchema.parse(evaluation.frozen_input);expect(parsed.verificationBindings!.issue!.connectionBinding.verificationVersion).toBe(1);expect(parsed.evidence[0].resourceIdentity).toMatchObject({provider:'github',repository:'example/support',id:'42'});
    await tenant(org,user,tx=>tx.execute(sql`update connections set verification_version=verification_version+1 where project_id=${project} and provider='github'`));
    const replay=await app.inject({method:'POST',url:`/v1/evaluations/${sourceEvaluationId}/replay`,headers,payload:{projectId:project}});expect(replay.statusCode).toBe(200);expect(replay.json().assessment.decision).toBe('pass');
    const datasetReplay=await app.inject({method:'POST',url:`/v1/datasets/${datasetId}/replay`,headers,payload:{projectId:project}});expect(datasetReplay.statusCode).toBe(200);expect(datasetReplay.json().cases[0].assessment.decision).toBe('pass');
  });
  it('freezes the current connection binding even when fresh verification is unavailable',async()=>{
    const input=await submitted();const oldBinding=structuredClone(input.evidence[0].connectionBinding!);
    await tenant(org,user,tx=>tx.execute(sql`update connections set verification_version=verification_version+1 where project_id=${project} and provider='github'`));
    const calls=vi.fn(async(frozen:FrozenRun)=>{
      expect(frozen.verificationBindings!.issue!.connectionBinding.verificationVersion).toBe(oldBinding.verificationVersion+1);
      return [{...input.evidence[0],id:randomUUID(),connectionBinding:frozen.verificationBindings!.issue!.connectionBinding,status:'unavailable' as const,properties:{}}];
    });
    const result=await evaluateJob(job(input),{collectEvidence:calls});expect(result.assessment?.decision).toBe('unknown');expect(result.assessment?.outcomes[0].verification).toBe('unknown');expect(calls).toHaveBeenCalledTimes(1);
    const [stored]=await tenant(org,user,tx=>rows<any>(tx,sql`select frozen_input from evaluations where project_id=${project} and id=${result.evaluationId}`));expect(stored.frozen_input.verificationBindings.issue.connectionBinding.verificationVersion).toBe(oldBinding.verificationVersion+1);
  });
  it('increments the connection version on OAuth reauthorization and preserves it on token refresh',async()=>{
    const priorClient=process.env.HUBSPOT_CLIENT_ID,priorSecret=process.env.HUBSPOT_CLIENT_SECRET;process.env.HUBSPOT_CLIENT_ID='synthetic-client';process.env.HUBSPOT_CLIENT_SECRET='synthetic-secret';
    let account=100,expires=1;
    const transport=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>Response.json({access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:expires,scopes:['oauth','crm.objects.contacts.read'],hub_id:account}));
    const authorize=async()=>{
      const start=await app.inject({method:'POST',url:'/v1/connections/hubspot/authorize',headers,payload:{projectId:project}});expect(start.statusCode).toBe(200);
      const state=new URL(start.json().url).searchParams.get('state')!;const cookies=start.cookies.map(cookie=>`${cookie.name}=${cookie.value}`).join('; ');
      const callback=await app.inject({url:`/v1/connections/hubspot/callback?state=${encodeURIComponent(state)}&code=synthetic-code`,headers:{...headers,cookie:`${headers.cookie}; ${cookies}`}});expect(callback.statusCode).toBe(302);
      return tenant(org,user,async tx=>(await rows<any>(tx,sql`select * from connections where project_id=${project} and provider='hubspot'`))[0]);
    };
    try{
      const first=await authorize();expect(first.verification_version).toBe(1);account=200;const second=await authorize();expect(second.id).toBe(first.id);expect(second.verification_version).toBe(2);
      expires=3600;await connectionToken(second,{organizationId:org,projectId:project});
      const [refreshed]=await tenant(org,user,tx=>rows<any>(tx,sql`select * from connections where project_id=${project} and provider='hubspot'`));expect(refreshed.verification_version).toBe(2);
      expect((await decrypt<any>(refreshed.credential,{organizationId:org,projectId:project})).hub_id).toBe(200);
      account=300;await authorize();transport.mockClear();await expect(connectionToken(second,{organizationId:org,projectId:project})).rejects.toThrow('changed');expect(transport).not.toHaveBeenCalled();
    }finally{transport.mockRestore();if(priorClient===undefined)delete process.env.HUBSPOT_CLIENT_ID;else process.env.HUBSPOT_CLIENT_ID=priorClient;if(priorSecret===undefined)delete process.env.HUBSPOT_CLIENT_SECRET;else process.env.HUBSPOT_CLIENT_SECRET=priorSecret;}
  });
});

describe('immutable run instance mapping',()=>{
  it('binds queued jobs and prevents a replacement run from completing a historical pending experiment',async()=>{
    const original=await submitted(`reuse-${randomUUID()}`,false);const created=await compare(original.id);expect(created.statusCode).toBe(201);expect(created.json().ready).toBe(false);const experimentId=created.json().experimentId;
    expect(created.json().candidates[0].cases[0].runInstanceId).toBe(original.runInstanceId);
    const [queued]=await pool.query(`select data from pgboss.job where name='evaluate-run' and data->>'runId'=$1`,[original.id]).then(result=>result.rows);expect(queued.data.instanceId).toBe(original.runInstanceId);
    await tenant(org,user,tx=>tx.execute(sql`delete from runs where project_id=${project} and id=${original.id}`));
    const replacement=await submitted(original.id);expect(replacement.runInstanceId).not.toBe(original.runInstanceId);
    const collect=vi.fn();expect((await evaluateJob(job(original),{collectEvidence:collect})).status).toBe('superseded_or_complete');expect(collect).not.toHaveBeenCalled();
    const result=await evaluateJob(job(replacement));expect(result.assessment?.decision).toBe('pass');
    const report=await app.inject({url:`/v1/experiments/${experimentId}?projectId=${project}`,headers});expect(report.statusCode).toBe(200);expect(report.json().exitCode).toBe(2);expect(report.json().candidates[0].cases[0].evaluationId).toBeNull();
    const fresh=await compare(original.id);expect(fresh.statusCode).toBe(201);expect(fresh.json().exitCode).toBe(0);
    await expect(tenant(org,user,tx=>enqueue(tx,job(original),0))).rejects.toThrow('instance changed');
  });
  it('makes legacy completed and pending mappings permanently indeterminate',async()=>{
    const source=await submitted();await evaluateJob(job(source));const fresh=await compare(source.id);expect(fresh.json().exitCode).toBe(0);
    const [saved]=await tenant(org,user,tx=>rows<any>(tx,sql`select * from experiments where project_id=${project} and id=${fresh.json().experimentId}`));
    for(const explicit of [true,false]){
      const snapshot=structuredClone(saved.candidates);for(const mapping of snapshot.candidates[0].runs){delete mapping.runInstanceId;if(!explicit)delete mapping.evaluationId;}
      const [legacy]=await tenant(org,user,tx=>rows<any>(tx,sql`insert into experiments(organization_id,project_id,name,dataset_id,policy_id,candidates) values(${org},${project},'Legacy mapping',${datasetId},${policyId},${JSON.stringify(snapshot)}::jsonb) returning id`));
      const response=await app.inject({url:`/v1/experiments/${legacy.id}?projectId=${project}`,headers});expect(response.json().ready).toBe(true);expect(response.json().exitCode).toBe(2);expect(response.json().candidates[0].cases[0].assertions[0].code).toBe('run_instance_unbound');
    }
  });
  it('protects server-generated run instances from mutation',async()=>{
    await expect(tenant(org,user,tx=>tx.execute(sql`update runs set instance_id=${randomUUID()} where project_id=${project} and id=${sourceRun}`))).rejects.toMatchObject({cause:{code:'P0001'}});
  });
});
