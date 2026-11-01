import { createHmac,timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { receiptSchema,limits } from '@agent-quality/contracts';
import { canonical,redact } from '../../../packages/contracts/src/redaction.ts';
import { tenant,rows,sql } from '@agent-quality/db';
import { enqueue } from '../../../packages/db/src/queue.ts';
import { authorize,digest } from './auth.ts';
import { assert } from './errors.ts';
export async function evidenceRoutes(app:FastifyInstance){
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json',{parseAs:'string'},(_request,body,done)=>done(null,body));
  app.post('/v1/evidence',{schema:{summary:'Submit a signed customer-verifier receipt; separate verifier credential required'}},async(request,reply)=>{
    const raw=String(request.body);let decoded:unknown;
    try{decoded=JSON.parse(raw);}catch{assert(false,400,'invalid_json','Receipt JSON is invalid.');}
    const body=receiptSchema.parse(decoded);const a=await authorize(request,{scope:'verifier',projectId:body.projectId});
    assert(a.keyId,403,'verifier_key_required','A separate verifier credential is required.');
    const timestamp=request.headers['x-receipt-timestamp'];const signature=request.headers['x-receipt-signature'];
    assert(typeof timestamp==='string' && /^\d+$/.test(timestamp)&&Math.abs(Date.now()/1000-Number(timestamp))<=300,401,'receipt_expired','Receipt signature timestamp is invalid or expired.');
    assert(typeof signature==='string'&&/^[a-f0-9]{64}$/.test(signature),401,'signature_invalid','Receipt signature is invalid.');
    const key=request.headers.authorization!.replace(/^Bearer /,'');
    const expected=createHmac('sha256',key).update(`${timestamp}.${raw}`).digest();
    assert(timingSafeEqual(expected,Buffer.from(signature,'hex')),401,'signature_invalid','Receipt signature is invalid.');
    assert(Date.parse(body.observedAt)<=Date.now()+60000,400,'future_observation','An observation cannot be in the future.');
    return tenant(a.organizationId,null,async tx=>{
      const [run]=await rows<any>(tx,sql`select * from runs where project_id=${body.projectId} and id=${body.runId} for update`);assert(run,404,'not_found','Run not found.');assert(!run.expired_at,410,'data_expired','Run content has expired.');
      const hash=digest(canonical(body));
      const observation={outcomeId:body.outcomeId,source:'customer_verifier',provider:'Customer-operated verifier',observedAt:body.observedAt,resourceId:body.resourceId,properties:redact(body.properties),status:body.status};
      const added=await rows<any>(tx,sql`insert into evidence(organization_id,project_id,run_id,receipt_id,hash,body) values(${a.organizationId},${body.projectId},${body.runId},${body.receiptId},${hash},${JSON.stringify(observation)}::jsonb) on conflict(organization_id,project_id,receipt_id) do nothing returning id`);
      if(!added.length){const [existing]=await rows<any>(tx,sql`select id,hash from evidence where project_id=${body.projectId} and receipt_id=${body.receiptId}`);assert(existing.hash===hash,409,'receipt_conflict','A receipt ID was reused with different content.');return reply.code(202).send({id:existing.id,duplicate:true,revision:run.revision});}
      const revision=run.revision+1;await tx.execute(sql`update runs set revision=${revision},last_event_at=now() where project_id=${body.projectId} and id=${body.runId}`);
      if(run.completed_at && run.auto_evaluations<=limits.automaticReevaluations)await enqueue(tx,{organizationId:a.organizationId,projectId:body.projectId,runId:body.runId,revision});
      return reply.code(202).send({id:added[0].id,duplicate:false,revision,provenance:'customer_verifier'});
    });
  });
}
