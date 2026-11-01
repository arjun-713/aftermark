import { afterAll,beforeAll,expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { buildServer } from '../../apps/api/src/server.ts';
import { pool,tenant,rows,sql } from '@agent-quality/db';
import { queue,queueName } from '../../packages/db/src/queue.ts';
import { eventSchema } from '@agent-quality/contracts';
let app=await buildServer();
const org='10000000-0000-4000-8000-000000000001',project='20000000-0000-4000-8000-000000000001';
let key='',keyId='',cookie='';const runId=`ingestion-${randomUUID()}`;
const event=(id:string,kind='message',payload:unknown={text:'Email private@example.test'},time='2026-11-01T10:00:00Z')=>({schemaVersion:'1.0',eventId:id,runId,kind,timestamp:time,agentVersion:'v1',environment:'test',payload});
const post=(events:unknown[])=>app.inject({method:'POST',url:'/v1/events',headers:{authorization:`Bearer ${key}`},payload:{projectId:project,events}});
beforeAll(async()=>{
  const login=await app.inject({method:'POST',url:'/v1/auth/login',payload:{email:'alex@example.test',password:'local-password-123'}});cookie=login.cookies.map(x=>`${x.name}=${x.value}`).join('; ');
  const response=await app.inject({method:'POST',url:'/v1/keys',headers:{cookie,'x-workspace-id':org},payload:{projectId:project,name:'Ingestion test',scopes:['ingest','read']}});expect(response.statusCode).toBe(200);key=response.json().secret;keyId=response.json().id;
});
afterAll(async()=>{await app.close();await pool.end();});
it('durably accepts and redacts a complete batch',async()=>{
  const response=await post([event(`${runId}-end`,'run.completed',{},'2026-11-01T10:00:03Z'),event(`${runId}-start`,'run.started',{agent:'Support agent'}),event(`${runId}-message`)]);expect(response.statusCode).toBe(202);expect(response.json().accepted).toBe(3);
  const data=await tenant(org,null,tx=>rows<any>(tx,sql`select event from events where project_id=${project} and run_id=${runId}`));expect(data).toHaveLength(3);expect(JSON.stringify(data)).not.toContain('private@example.test');
});
it('does not change the revision or queue another job for identical duplicates',async()=>{
  const response=await post([event(`${runId}-message`)]);expect(response.statusCode).toBe(202);expect(response.json().duplicates).toBe(1);
  const [run]=await tenant(org,null,tx=>rows<any>(tx,sql`select revision,execution_status from runs where project_id=${project} and id=${runId}`));expect(run.revision).toBe(1);expect(run.execution_status).toBe('completed');
});
it('rolls back the entire batch when an existing event conflicts',async()=>{
  const response=await post([event(`${runId}-new`),event(`${runId}-message`,'message',{text:'Different content'})]);expect(response.statusCode).toBe(409);
  const data=await tenant(org,null,tx=>rows(tx,sql`select * from event_keys where project_id=${project} and event_id=${`${runId}-new`}`));expect(data).toHaveLength(0);
});
it('keeps acknowledged data and processing jobs across API/queue restarts',async()=>{
  await app.close();app=await buildServer();await app.ready();
  const response=await app.inject({url:`/v1/runs/${runId}?projectId=${project}`,headers:{authorization:`Bearer ${key}`}});expect(response.statusCode).toBe(200);expect(response.json().events).toHaveLength(3);
  const jobs=await(await queue()).findJobs<any>(queueName,{data:{runId}});expect(jobs.length).toBeGreaterThan(0);expect(jobs[0].data.runId).toBe(runId);
});
it('bounds decompressed gzip payloads',async()=>{
  const large=gzipSync(JSON.stringify({projectId:project,events:[event('large','message',{text:'x'.repeat(1100000)})]}));
  const response=await app.inject({method:'POST',url:'/v1/events',headers:{authorization:`Bearer ${key}`,'content-type':'application/json','content-encoding':'gzip'},payload:large});expect(response.statusCode).toBe(413);
});
it('preserves structural identifiers while redacting only the payload',async()=>{
  const structural={...event(`aq_event_${randomUUID().replaceAll('-','')}`,'run.started',{agent:'Identifier test',text:'private@example.test'}),runId:`aq_run_${randomUUID().replaceAll('-','')}`,spanId:'aq_span_abcdefghijklmnopqrstuv'};
  expect((await post([structural])).statusCode).toBe(202);
  const [stored]=await tenant(org,null,tx=>rows<any>(tx,sql`select event from events where project_id=${project} and event_id=${structural.eventId}`));
  expect(eventSchema.safeParse(stored.event).success).toBe(true);expect(stored.event.eventId).toBe(structural.eventId);expect(stored.event.runId).toBe(structural.runId);expect(stored.event.spanId).toBe(structural.spanId);expect(stored.event.payload.text).not.toContain('private@example.test');
});
it('does not expose workspace billing through a project read key',async()=>{expect((await app.inject({url:'/v1/usage',headers:{authorization:`Bearer ${key}`}})).statusCode).toBe(403);});
it('accepts valid gzip, rejects forged organization identity and revoked keys',async()=>{
  const zipped=gzipSync(JSON.stringify({projectId:project,events:[event(`${runId}-late`)]}));
  expect((await app.inject({method:'POST',url:'/v1/events',headers:{authorization:`Bearer ${key}`,'content-type':'application/json','content-encoding':'gzip'},payload:zipped})).statusCode).toBe(202);
  expect((await post([{...event('forged'),organizationId:org}])).statusCode).toBe(400);
  const revoke=await app.inject({method:'DELETE',url:`/v1/keys/${keyId}`,headers:{cookie,'x-workspace-id':org}});expect(revoke.statusCode).toBe(200);expect((await post([event('revoked')])).statusCode).toBe(401);
});
