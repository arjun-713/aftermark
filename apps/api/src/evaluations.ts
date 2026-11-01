import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenant,rows,sql } from '@agent-quality/db';
import { policySchema } from '@agent-quality/contracts';
import { canonical } from '../../../packages/contracts/src/redaction.ts';
import { enqueue } from '../../../packages/db/src/queue.ts';
import { assess } from '../../../packages/evaluation/src/index.ts';
import { validateJevResponse,jevModel } from '../../../packages/evaluation/src/jev.ts';
import { detectorHash } from '../../../packages/evaluation/src/calibration.ts';
import { authorize,digest } from './auth.ts';
import { audit } from './management.ts';
import { assert } from './errors.ts';
export async function evaluationRoutes(app:FastifyInstance) {
  app.post('/v1/runs/:id/evaluate',async(request,reply)=>{
    const {id}=z.object({id:z.string().min(1).max(128)}).parse(request.params);
    const body=z.object({projectId:z.uuid(),policyId:z.uuid().optional()}).parse(request.body);
    const a=await authorize(request,{scope:'evaluate',roles:['owner','admin','member'],projectId:body.projectId});
    return tenant(a.organizationId,a.userId,async tx=>{
      const [run]=await rows<any>(tx,sql`select * from runs where project_id=${body.projectId} and id=${id}`);assert(run,404,'not_found','Run not found.');assert(!run.expired_at,410,'data_expired','Run content has expired.');
      if(body.policyId)assert((await rows(tx,sql`select id from policies where project_id=${body.projectId} and id=${body.policyId}`)).length,404,'policy_not_found','Policy not found.');
      const jobId=await enqueue(tx,{organizationId:a.organizationId,projectId:body.projectId,runId:id,revision:run.revision,policyId:body.policyId,explicit:true},0);
      return reply.code(202).send({jobId,revision:run.revision,processing:'pending'});
    });
  });
  app.post('/v1/evaluations/:id/replay',async request=>{
    const {id}=z.object({id:z.uuid()}).parse(request.params);const {projectId}=z.object({projectId:z.uuid()}).parse(request.body);
    const a=await authorize(request,{scope:'evaluate',roles:['owner','admin','member'],projectId});
    return tenant(a.organizationId,a.userId,async tx=>{
      const [evaluation]=await rows<any>(tx,sql`select * from evaluations where project_id=${projectId} and id=${id}`);assert(evaluation?.frozen_input,404,'not_found','Frozen evaluation not found.');
      let semantic;try{if(evaluation.provider_response)semantic=validateJevResponse(evaluation.provider_response,evaluation.frozen_input.policy);}catch{/* The replay retains uncertainty. */}
      return {assessment:assess(evaluation.frozen_input,semantic),sourceEvaluationId:id,replay:true,repeatedExternalRequests:false};
    });
  });
  app.get('/v1/policies',async request=>{
    const {projectId}=z.object({projectId:z.uuid()}).parse(request.query);const a=await authorize(request,{scope:'read',projectId});
    return tenant(a.organizationId,a.userId,tx=>rows(tx,sql`select p.*,pr.active_policy_id=p.id as active from policies p join projects pr on pr.organization_id=p.organization_id and pr.id=p.project_id where project_id=${projectId} order by version desc`));
  });
  app.post('/v1/policies',async request=>{
    const body=z.object({projectId:z.uuid(),definition:policySchema}).parse(request.body);const a=await authorize(request,{sessionOnly:true,roles:['owner','admin'],projectId:body.projectId});
    assert(new Set(body.definition.checks.map(c=>c.id)).size===body.definition.checks.length,400,'duplicate_check','Check IDs must be unique.');
    return tenant(a.organizationId,a.userId,async tx=>{
      await tx.execute(sql`select id from projects where id=${body.projectId} for update`);
      if(body.definition.semanticBlocking || body.definition.checks.some(c=>c.blocking)){
        const [report]=body.definition.calibrationReportId?await rows<any>(tx,sql`select * from calibration_reports where project_id=${body.projectId} and id=${body.definition.calibrationReportId}`):[];
        assert(body.definition.semanticEnabled && report?.passed && report.detector_hash===detectorHash(body.definition),409,'calibration_required','Blocking semantic checks require a passed calibration report for this exact detector configuration.');
      }
      const [{version}]=await rows<any>(tx,sql`select coalesce(max(version),0)+1 as version from policies where project_id=${body.projectId}`);
      const [policy]=await rows<any>(tx,sql`insert into policies(organization_id,project_id,version,definition,hash,created_by) values(${a.organizationId},${body.projectId},${version},${JSON.stringify(body.definition)}::jsonb,${digest(canonical(body.definition))},${a.userId}) returning *`);
      await audit(tx,a.organizationId,a.userId,'policy.created',policy.id);return policy;
    });
  });
  app.post('/v1/policies/:id/activate',async request=>{
    const {id}=z.object({id:z.uuid()}).parse(request.params);const {projectId}=z.object({projectId:z.uuid()}).parse(request.body);const a=await authorize(request,{sessionOnly:true,roles:['owner','admin'],projectId});
    return tenant(a.organizationId,a.userId,async tx=>{
      assert((await rows(tx,sql`select id from policies where project_id=${projectId} and id=${id}`)).length,404,'not_found','Policy not found.');
      await tx.execute(sql`update projects set active_policy_id=${id} where id=${projectId}`);await audit(tx,a.organizationId,a.userId,'policy.activated',id);return {ok:true};
    });
  });
  app.post('/v1/policies/:id/preview',async request=>{
    const {id}=z.object({id:z.uuid()}).parse(request.params);const {projectId,runId}=z.object({projectId:z.uuid(),runId:z.string()}).parse(request.body);const a=await authorize(request,{roles:['owner','admin','member'],sessionOnly:true,projectId});
    return tenant(a.organizationId,a.userId,async tx=>{
      const [policy]=await rows<any>(tx,sql`select definition from policies where project_id=${projectId} and id=${id}`);
      const [source]=await rows<any>(tx,sql`select frozen_input from evaluations where project_id=${projectId} and run_id=${runId} order by created_at desc limit 1`);
      assert(policy && source?.frozen_input,404,'not_found','A policy and evaluated run are required for preview.');
      return {assessment:assess({...source.frozen_input,policy:policy.definition,calibrationApproved:false}),preview:true,semanticProviderCalled:false};
    });
  });
  app.post('/v1/calibration-reports',async request=>{
    const body=z.object({projectId:z.uuid(),report:z.object({model:z.literal(jevModel),detectorHash:z.string().length(64),totalCases:z.number().int().min(400),holdoutCases:z.number().int().min(100),holdoutHash:z.string().length(64),truePositives:z.number().int().min(0),falsePositives:z.number().int().min(0),coverage:z.number().min(0).max(1),humanLabelAttestation:z.literal(true)})}).parse(request.body);
    const a=await authorize(request,{sessionOnly:true,roles:['owner','admin'],projectId:body.projectId});const r=body.report;
    assert(r.holdoutCases===r.totalCases/4 && r.truePositives+r.falsePositives<=r.holdoutCases,400,'invalid_calibration','A sealed 25% holdout and consistent counts are required.');
    const emitted=r.truePositives+r.falsePositives;const passed=emitted>0 && r.truePositives/emitted>=0.95;
    return tenant(a.organizationId,a.userId,async tx=>{
      const [report]=await rows<any>(tx,sql`insert into calibration_reports(organization_id,project_id,detector_hash,report,passed,approved_by) values(${a.organizationId},${body.projectId},${r.detectorHash},${JSON.stringify(r)}::jsonb,${passed},${a.userId}) returning id,passed`);await audit(tx,a.organizationId,a.userId,'calibration.attested',report.id);return report;
    });
  });
}
