import type { FastifyInstance } from 'fastify';
import { createGunzip } from 'node:zlib';
import { Transform } from 'node:stream';
import { z } from 'zod';
import { eventBatchSchema,type AgentEvent,limits } from '@agent-quality/contracts';
import { canonical,redact } from '../../../packages/contracts/src/redaction.ts';
import { tenant,rows,sql } from '@agent-quality/db';
import { enqueue,queue,stopQueue } from '../../../packages/db/src/queue.ts';
import { authorize,digest,type Identity } from './auth.ts';
import { assert,ApiError } from './errors.ts';
import { mapOtlp } from './otlp.ts';

export async function ingest(a:Identity,projectId:string,events:AgentEvent[]) {
  return tenant(a.organizationId,a.userId,async tx=>{
    let accepted=0,duplicates=0;
    const runIds=[...new Set(events.map(e=>e.runId))].sort();
    for(const runId of runIds) {
      const incoming=events.filter(e=>e.runId===runId).sort((a,b)=>a.timestamp.localeCompare(b.timestamp)||a.eventId.localeCompare(b.eventId));
      const first=incoming[0];
      const inserted=await rows(tx,sql`insert into runs(organization_id,project_id,id,agent,agent_version,environment,started_at,last_event_at) values(${a.organizationId},${projectId},${runId},${first.payload.agent??'Agent'},${first.agentVersion},${first.environment},${first.timestamp},now()) on conflict do nothing returning id`);
      const [run]=await rows<any>(tx,sql`select * from runs where project_id=${projectId} and id=${runId} for update`);
      assert(!run.expired_at,410,'data_expired','This run expired under the retention policy. Use a new run ID.');
      let added=0;
      for(const event of incoming) {
        assert(event.agentVersion===run.agent_version && event.environment===run.environment,409,'run_identity_conflict','Agent version and environment cannot change during a run.');
        const hash=digest(canonical(event));
        const key=await rows(tx,sql`insert into event_keys(organization_id,project_id,event_id,run_id,hash) values(${a.organizationId},${projectId},${event.eventId},${runId},${hash}) on conflict do nothing returning event_id`);
        if(!key.length) {
          const [existing]=await rows<any>(tx,sql`select hash,run_id from event_keys where project_id=${projectId} and event_id=${event.eventId}`);
          assert(existing.hash===hash && existing.run_id===runId,409,'event_conflict','An event ID was reused with different contents. The batch was rolled back.');duplicates++;continue;
        }
        await tx.execute(sql`insert into events(organization_id,project_id,event_id,run_id,event) values(${a.organizationId},${projectId},${event.eventId},${runId},${JSON.stringify({...event,timestamp:new Date(event.timestamp).toISOString(),payload:redact(event.payload)})}::jsonb)`);added++;accepted++;
      }
      if(!added)continue;
      const all=(await rows<any>(tx,sql`select event from events where project_id=${projectId} and run_id=${runId} order by event->>'timestamp',event_id`)).map(r=>r.event as AgentEvent);
      const terminals=all.filter(e=>['run.completed','run.failed','run.cancelled'].includes(e.kind));
      const terminal=terminals.at(-1);
      const revision=run.revision+(inserted.length?0:1);
      const status=terminal?.kind.split('.')[1]??'running';
      const agent=all.find(e=>e.kind==='run.started')?.payload.agent??run.agent;
      await tx.execute(sql`update runs set revision=${revision},agent=${agent},started_at=${all[0].timestamp},last_event_at=now(),completed_at=${terminal?.timestamp??null},execution_status=${status} where project_id=${projectId} and id=${runId}`);
      if(terminal && run.auto_evaluations<=limits.automaticReevaluations) await enqueue(tx,{organizationId:a.organizationId,projectId,runId,revision});
    }
    return {accepted,duplicates,runIds,durable:true};
  });
}

export async function ingestionRoutes(app:FastifyInstance) {
  app.addHook('onReady',async()=>{await queue();});
  app.addHook('onClose',async()=>{await stopQueue();});
  app.addHook('preParsing',(request,_reply,payload,done)=>{
    const encoding=request.headers['content-encoding'];
    if(!encoding || encoding==='identity'){done(null,payload);return;}
    if(encoding!=='gzip'){done(new ApiError(415,'unsupported_encoding','Only identity and gzip encodings are supported.'));return;}
    let encoded=0,decoded=0;const gunzip=createGunzip();
    const limit=new Transform({transform(chunk,_encoding,callback){decoded+=chunk.length;if(decoded>limits.batchBytes)callback(new ApiError(413,'payload_too_large','Decompressed request exceeds 1 MiB.'));else callback(null,chunk);}});
    Object.defineProperty(limit,'receivedEncodedLength',{get:()=>encoded});
    payload.on('data',chunk=>{encoded+=chunk.length;});
    payload.on('error',error=>limit.destroy(error));gunzip.on('error',()=>limit.destroy(new ApiError(400,'invalid_gzip','The gzip request is invalid.')));
    limit.on('error',()=>{gunzip.destroy();payload.unpipe(gunzip);});
    done(null,payload.pipe(gunzip).pipe(limit));
  });
  const schema=z.toJSONSchema(eventBatchSchema,{target:'draft-7'});
  delete schema.$schema;
  app.post('/v1/events',{schema:{summary:'Atomically accept up to 100 events (1 MiB decompressed)',body:schema as any,security:[{apiKey:[]}]}},async(request,reply)=>{
    const body=eventBatchSchema.parse(request.body);
    const a=await authorize(request,{scope:'ingest',roles:['owner','admin','member'],projectId:body.projectId});
    return reply.code(202).send(await ingest(a,body.projectId,body.events));
  });
  app.post('/v1/traces',{schema:{summary:'Import pinned OTLP HTTP JSON mapping v1'}},async(request,reply)=>{
    const body=z.object({projectId:z.uuid(),resourceSpans:z.array(z.unknown()).max(100)}).strict().parse(request.body);
    const a=await authorize(request,{scope:'ingest',roles:['owner','admin','member'],projectId:body.projectId});
    const events=mapOtlp(body.resourceSpans); assert(events.length>0 && events.length<=100,400,'otlp_batch_limit','The mapping must produce 1–100 events per request.');
    return reply.code(202).send({...await ingest(a,body.projectId,events),mappingVersion:'otlp-json-v1',limitations:['Expected outcomes are not inferred from imported traces. Configure explicit outcomes or policy tool mappings.']});
  });
}
