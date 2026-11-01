import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { tenant,rows,sql,pool,assertApplicationRole,type Tx } from '@agent-quality/db';
import { config } from '../../packages/db/src/config.ts';
import { stopQueue } from '../../packages/db/src/queue.ts';
import { alertRoutes } from '../../apps/api/src/alerts.ts';
import { ApiError } from '../../apps/api/src/errors.ts';
import { initializeAlertQueues,scheduleEvaluationAlerts,runAlertDelivery,markAlertDeadLetter,replayAlert,verifyAlert,alertQueueName,alertDeadLetterQueue,type AlertCompletion,type AlertJob } from '../../packages/alerts/src/index.ts';
import type { Job } from 'pg-boss';

if (new URL(process.env.DATABASE_URL??'').pathname !== '/aq_alerts_test') throw new Error('Alert integration tests require isolated aq_alerts_test.');
process.env.KMS_KEY_ID='';process.env.LOCAL_ENCRYPTION_KEY='alerts-fixture-key-only';
const user=randomUUID(),otherUser=randomUUID(),project=randomUUID(),otherProject=randomUUID(),secret='synthetic-signing-secret-at-least-32-characters';
let org:string,otherOrg:string,token:string,policy:string;
const resolver=async()=>[{address:'8.8.8.8',family:4}];
const app=Fastify();await app.register(cookie);
app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof ApiError?error.status:400).send({error:{code:error instanceof ApiError?error.code:'invalid_request'}}));
await alertRoutes(app,{resolver});
const headers=()=>({cookie:`aq_session=${token}`,'x-workspace-id':org});
let endpointCounter=0;
async function destination() {
  const res=await app.inject({method:'POST',url:'/v1/alerts/destinations',headers:headers(),payload:{projectId:project,name:'Test destination',url:`https://hooks.example.com/${++endpointCounter}`,signingSecret:secret}});
  expect(res.statusCode).toBe(201);return res.json();
}
function completion():AlertCompletion {
  return {organizationId:org,projectId:project,evaluationId:randomUUID(),revision:1,assessment:{processing:'completed',decision:'fail',outcomes:[{id:'private-outcome-id',name:'PRIVATE TRACE NAME',reason:'PRIVATE MODEL CONTEXT',required:true,verification:'contradicted',evidenceIds:['customer-resource']}]}};
}
async function insertEvaluation(tx:Tx,input:AlertCompletion) {
  const run=`alert-fixture-${input.evaluationId}`;
  await tx.execute(sql`insert into runs(organization_id,project_id,id,agent_version,environment,started_at,last_event_at) values(${org},${project},${run},'v1','test',now(),now())`);
  await tx.execute(sql`insert into evaluations(organization_id,project_id,id,run_id,revision,policy_id,policy_hash,processing,assessment,completed_at) values(${org},${project},${input.evaluationId},${run},1,${policy},'policy-fixture','completed',${JSON.stringify(input.assessment)}::jsonb,now())`);
}
async function scheduled() {
  const input=completion();
  await tenant(org,user,async tx=>{await insertEvaluation(tx,input);expect(await scheduleEvaluationAlerts(tx,input)).toBeGreaterThan(0);});
  const [delivery]=await tenant(org,user,tx=>rows<any>(tx,sql`select * from alert_deliveries where evaluation_id=${input.evaluationId} order by created_at,id limit 1`));
  return {input,delivery,data:{organizationId:org,projectId:project,deliveryId:delivery.id,generation:0} as AlertJob};
}
beforeAll(async()=>{
  await assertApplicationRole();
  for (const id of [user,otherUser]) await tenant('',id,tx=>tx.execute(sql`select provision_user(${id},${`${id}@example.test`},'Alert fixture')`));
  org=(await tenant('',user,tx=>rows<any>(tx,sql`select create_workspace(${user},'Alert fixture') as id`)))[0].id;
  otherOrg=(await tenant('',otherUser,tx=>rows<any>(tx,sql`select create_workspace(${otherUser},'Other alert fixture') as id`)))[0].id;
  await tenant(org,user,async tx=>{
    await tx.execute(sql`insert into projects(organization_id,id,name) values(${org},${project},'Alert fixture')`);
    const [p]=await rows<any>(tx,sql`insert into policies(organization_id,project_id,version,definition,hash) values(${org},${project},1,'{"name":"Fixture","semanticEnabled":false,"checks":[],"toolMappings":[]}'::jsonb,'policy-fixture') returning id`);policy=p.id;
  });
  await tenant(otherOrg,otherUser,async tx=>{
    await tx.execute(sql`insert into projects(organization_id,id,name) values(${otherOrg},${otherProject},'Other alert fixture')`);
    await tx.execute(sql`insert into memberships(organization_id,user_id,role) values(${otherOrg},${user},'viewer')`);
  });
  token=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setSubject(user).setIssuer('agent-quality-local').setAudience('agent-quality').setExpirationTime('1h').sign(new TextEncoder().encode(config.SESSION_SECRET));
  await app.ready();
});
afterAll(async()=>{
  for (const id of [org,otherOrg]) if(id) await tenant(id,null,async tx=>{
    await tx.execute(sql`delete from pgboss.job where data->>'organizationId'=${id}`);
    await tx.execute(sql`delete from runs`);await tx.execute(sql`delete from organizations where id=${id}`);
  });
  await app.close();await stopQueue();await pool.end();
});
describe('configured project alerts',()=>{
  it('starts with no destinations and schedules nothing by default',async()=>{
    expect((await app.inject({url:`/v1/alerts/destinations?projectId=${project}`,headers:headers()})).json()).toEqual([]);
    const input=completion();await tenant(org,user,async tx=>{await insertEvaluation(tx,input);expect(await scheduleEvaluationAlerts(tx,input)).toBe(0);});
  });
  it('authorizes configuration by the selected workspace role and never lists signing secrets',async()=>{
    const created=await destination();expect(created.signingSecret).toBe(secret);
    const listed=await app.inject({url:`/v1/alerts/destinations?projectId=${project}`,headers:headers()});
    expect(JSON.stringify(listed.json())).not.toContain(secret);expect(JSON.stringify(listed.json())).not.toContain('secret_envelope');
    const [encrypted]=await tenant(org,null,tx=>rows<any>(tx,sql`select secret_envelope from alert_destinations where id=${created.id}`));expect(JSON.stringify(encrypted)).not.toContain(secret);
    expect((await app.inject({url:`/v1/alerts/destinations?projectId=${otherProject}`,headers:{...headers(),'x-workspace-id':otherOrg}})).statusCode).toBe(403);
    expect((await app.inject({url:`/v1/alerts/destinations?projectId=${project}`})).statusCode).toBe(401);
    expect((await app.inject({url:`/v1/alerts/destinations?projectId=${project}`,headers:{authorization:'Bearer aq_synthetic_invalid_key'}})).statusCode).toBe(403);
  });
  it('rolls the evaluation completion, delivery and pg-boss enqueue back together',async()=>{
    const input=completion();const before=(await pool.query('select count(*)::int as count from pgboss.job')).rows[0].count;
    await expect(tenant(org,user,async tx=>{await insertEvaluation(tx,input);await scheduleEvaluationAlerts(tx,input);throw new Error('synthetic rollback');})).rejects.toThrow('synthetic rollback');
    expect(await tenant(org,user,tx=>rows(tx,sql`select id from evaluations where id=${input.evaluationId}`))).toHaveLength(0);
    expect(await tenant(org,user,tx=>rows(tx,sql`select id from alert_deliveries where evaluation_id=${input.evaluationId}`))).toHaveLength(0);
    expect((await pool.query('select count(*)::int as count from pgboss.job')).rows[0].count).toBe(before);
  });
  it('schedules one stable delivery per evaluation/destination under duplicate completion calls',async()=>{
    const {input,delivery}=await scheduled();
    await tenant(org,user,async tx=>expect(await scheduleEvaluationAlerts(tx,input)).toBe(0));
    const jobs=await pool.query("select data from pgboss.job where name=$1 and data->>'deliveryId'=$2",[alertQueueName,delivery.id]);expect(jobs.rows).toHaveLength(1);
    expect(Object.keys(jobs.rows[0].data).sort()).toEqual(['deliveryId','generation','organizationId','projectId']);
    expect(delivery.raw_body).not.toContain('PRIVATE');expect(delivery.raw_body).not.toContain('customer-resource');expect(delivery.raw_body).not.toContain(secret);
  });
  it('retries with the same event ID/body and valid fresh signatures, then ignores a duplicate job',async()=>{
    const {data,delivery}=await scheduled(),sent:{headers:Record<string,string>;body:string}[]=[];
    const transport=async(_target:unknown,h:Record<string,string>,body:string)=>{sent.push({headers:h,body});return sent.length===1?503:204;};
    await expect(runAlertDelivery({data,retryCount:0},{resolver,transport,now:()=>2000000000000})).rejects.toThrow('http_5xx');
    expect(await runAlertDelivery({data,retryCount:1},{resolver,transport,now:()=>2000000001000})).toEqual({state:'delivered'});
    expect(await runAlertDelivery({data,retryCount:2},{resolver,transport})).toEqual({state:'ignored'});expect(sent).toHaveLength(2);
    expect(sent[0].body).toBe(sent[1].body);expect(sent[1].body).toBe(delivery.raw_body);
    for(const item of sent){expect(item.headers['idempotency-key']).toBe(data.deliveryId);expect(item.headers['x-aq-event-id']).toBe(data.deliveryId);expect(verifyAlert(secret,item.headers['x-aq-timestamp'],item.body,item.headers['x-aq-signature'],Number(item.headers['x-aq-timestamp'])*1000)).toBe(true);}
  });
  it('blocks DNS rebinding before HTTP and stores only a sanitized failure code',async()=>{
    const {data}=await scheduled();let calls=0;
    await expect(runAlertDelivery({data,retryCount:0},{resolver:async()=>[{address:'169.254.169.254',family:4}],transport:async()=>{calls++;return 200;}})).rejects.toThrow('dns_rejected');expect(calls).toBe(0);
    const [item]=await tenant(org,user,tx=>rows<any>(tx,sql`select state,last_error from alert_deliveries where id=${data.deliveryId}`));expect(item).toEqual({state:'retrying',last_error:'dns_rejected'});
  });
  it('does not deliver a signing envelope copied from another destination',async()=>{
    const first=(await tenant(org,user,tx=>rows<any>(tx,sql`select * from alert_destinations where project_id=${project} order by created_at limit 1`)))[0];
    const second=await destination(),{data,delivery}=await scheduled();
    // Ensure the selected delivery's envelope names the other destination even though the tenant context matches.
    const wrong=delivery.destination_id===second.id?first:await tenant(org,user,tx=>rows<any>(tx,sql`select * from alert_destinations where id=${second.id}`)).then(v=>v[0]);
    const [original]=await tenant(org,user,tx=>rows<any>(tx,sql`select secret_envelope from alert_destinations where id=${delivery.destination_id}`));
    let calls=0;
    await tenant(org,user,tx=>tx.execute(sql`update alert_destinations set secret_envelope=${JSON.stringify(wrong.secret_envelope)}::jsonb where id=${delivery.destination_id}`));
    await expect(runAlertDelivery({data,retryCount:0},{resolver,transport:async()=>{calls++;return 204;}})).rejects.toThrow('secret_invalid');expect(calls).toBe(0);
    await tenant(org,user,tx=>tx.execute(sql`update alert_destinations set secret_envelope=${JSON.stringify(original.secret_envelope)}::jsonb where id=${delivery.destination_id}`));
  });
  it('uses native bounded retry/dead-letter flow and reconciles a final-attempt worker crash',async()=>{
    const {data,delivery}=await scheduled(),boss=await initializeAlertQueues();
    await pool.query("delete from pgboss.job where name=$1 and id<>$2 and data->>'organizationId'=$3",[alertQueueName,delivery.queue_job_id,org]);
    let lastJob:Job<AlertJob>|undefined;
    for(let attempt=0;attempt<5;attempt++){
      await pool.query('update pgboss.job set start_after=now() where id=$1',[delivery.queue_job_id]);
      const [job]=await boss.fetch<AlertJob>(alertQueueName,{batchSize:1});expect(job?.id).toBe(delivery.queue_job_id);expect(job.retryCount).toBe(attempt);lastJob=job;
      await expect(runAlertDelivery(job,{resolver,transport:async()=>503})).rejects.toThrow('http_5xx');
      await boss.fail(alertQueueName,{id:job.id,retryCount:job.retryCount},{code:'sanitized-delivery-failure'});
    }
    const dead=await pool.query("select data from pgboss.job where name=$1 and data->>'deliveryId'=$2",[alertDeadLetterQueue,data.deliveryId]);expect(dead.rows).toHaveLength(1);
    await tenant(org,user,tx=>tx.execute(sql`update alert_deliveries set state='delivering' where id=${data.deliveryId}`));
    await markAlertDeadLetter(lastJob!.data);
    const [item]=await tenant(org,user,tx=>rows<any>(tx,sql`select state,attempt_count from alert_deliveries where id=${data.deliveryId}`));expect(item).toEqual({state:'dead_letter',attempt_count:5});
    const replay=await app.inject({method:'POST',url:`/v1/alerts/deliveries/${data.deliveryId}/replay`,headers:headers(),payload:{projectId:project,expectedGeneration:0,confirm:'replay'}});expect(replay.statusCode).toBe(202);expect(replay.json().eventId).toBe(data.deliveryId);
    expect(await runAlertDelivery({data,retryCount:0},{resolver,transport:async()=>{throw new Error('stale job must not send');}})).toEqual({state:'ignored'});
    expect((await app.inject({url:`/v1/alerts/health?projectId=${project}`,headers:headers()})).statusCode).toBe(200);
    expect((await app.inject({url:`/v1/alerts/deliveries?projectId=${project}`,headers:headers()})).statusCode).toBe(200);
  });
  it('requires an enabled destination and limits replay counts/cooldown without changing the payload',async()=>{
    const {data,delivery}=await scheduled();
    await tenant(org,user,tx=>tx.execute(sql`update alert_destinations set enabled=false where id=${delivery.destination_id}`));
    expect(await runAlertDelivery({data,retryCount:0},{resolver,transport:async()=>{throw new Error('disabled destination must not send');}})).toEqual({state:'ignored'});
    expect(await tenant(org,user,tx=>replayAlert(tx,{organizationId:org,projectId:project,deliveryId:data.deliveryId,expectedGeneration:0}))).toBeNull();
    await tenant(org,user,tx=>tx.execute(sql`update alert_destinations set enabled=true where id=${delivery.destination_id}`));
    expect(await tenant(org,user,tx=>replayAlert(tx,{organizationId:org,projectId:project,deliveryId:data.deliveryId,expectedGeneration:0}))).toMatchObject({generation:1,eventId:data.deliveryId});
    await tenant(org,user,tx=>tx.execute(sql`update alert_deliveries set state='dead_letter' where id=${data.deliveryId}`));
    expect(await tenant(org,user,tx=>replayAlert(tx,{organizationId:org,projectId:project,deliveryId:data.deliveryId,expectedGeneration:1}))).toBeNull();
    await tenant(org,user,tx=>tx.execute(sql`update alert_deliveries set replay_count=3,last_replayed_at=now()-interval '2 minutes' where id=${data.deliveryId}`));
    expect(await tenant(org,user,tx=>replayAlert(tx,{organizationId:org,projectId:project,deliveryId:data.deliveryId,expectedGeneration:1}))).toBeNull();
    const [same]=await tenant(org,user,tx=>rows<any>(tx,sql`select raw_body from alert_deliveries where id=${data.deliveryId}`));expect(same.raw_body).toBe(delivery.raw_body);
  });
  it('rotates a secret once, keeps reads private and enforces RLS on both alert tables',async()=>{
    const [existing]=await tenant(org,user,tx=>rows<any>(tx,sql`select id from alert_destinations where project_id=${project} order by created_at limit 1`));
    const rotated=await app.inject({method:'POST',url:`/v1/alerts/destinations/${existing.id}/rotate-secret`,headers:headers(),payload:{projectId:project}});expect(rotated.statusCode).toBe(200);expect(rotated.json().signingSecret).not.toBe(secret);
    expect((await pool.query('select * from alert_destinations')).rows).toHaveLength(0);expect((await pool.query('select * from alert_deliveries')).rows).toHaveLength(0);
    expect(await tenant(otherOrg,otherUser,tx=>rows(tx,sql`select id from alert_deliveries`))).toHaveLength(0);
  });
});
