import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenant,rows,sql } from '@agent-quality/db';
import { authorize } from './auth.ts';
import { assert } from './errors.ts';
export async function runRoutes(app:FastifyInstance) {
  app.get('/v1/runs',async request=>{
    const q=z.object({projectId:z.uuid(),environment:z.enum(['production','staging','test']).optional(),agent:z.string().max(160).optional(),version:z.string().max(120).optional(),decision:z.enum(['pass','fail','review','unknown','pending']).optional(),search:z.string().max(200).optional(),from:z.string().datetime().optional(),to:z.string().datetime().optional(),cursor:z.string().max(500).optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).parse(request.query);
    const a=await authorize(request,{scope:'read',projectId:q.projectId});
    const cursor=q.cursor?z.object({time:z.string().datetime(),id:z.string()}).parse(JSON.parse(Buffer.from(q.cursor,'base64url').toString())):null;
    const filters=sql`r.project_id=${q.projectId} and (${q.environment??null}::text is null or r.environment=${q.environment??null}) and (${q.agent??null}::text is null or r.agent=${q.agent??null}) and (${q.version??null}::text is null or r.agent_version=${q.version??null}) and (${q.decision??null}::text is null or coalesce(e.assessment->>'decision','pending')=${q.decision??null}) and (${q.search??null}::text is null or r.id ilike ${`%${q.search??''}%`} or r.agent ilike ${`%${q.search??''}%`}) and (${q.from??null}::timestamptz is null or r.started_at>=${q.from??null}) and (${q.to??null}::timestamptz is null or r.started_at<=${q.to??null})`;
    return tenant(a.organizationId,a.userId,async tx=>{
      const list=await rows<any>(tx,sql`select r.*,e.processing,e.assessment->>'decision' as decision,e.assessment->'outcomes' as outcomes,e.assessment->'findings' as findings,e.revision as evaluated_revision from runs r left join evaluations e on e.organization_id=r.organization_id and e.project_id=r.project_id and e.id=r.latest_evaluation_id where ${filters} and (${cursor?.time??null}::timestamptz is null or (r.started_at,r.id)<(${cursor?.time??null}::timestamptz,${cursor?.id??''})) order by r.started_at desc,r.id desc limit ${q.limit+1}`);
      const [{count}]=await rows<any>(tx,sql`select count(*)::int as count from runs r left join evaluations e on e.organization_id=r.organization_id and e.project_id=r.project_id and e.id=r.latest_evaluation_id where ${filters}`);
      const hasMore=list.length>q.limit;const items=list.slice(0,q.limit);const last=items.at(-1);
      return {items,total:count,nextCursor:hasMore?Buffer.from(JSON.stringify({time:new Date(last.started_at).toISOString(),id:last.id})).toString('base64url'):null};
    });
  });
  app.get('/v1/runs/:id',async request=>{
    const {id}=z.object({id:z.string().min(1).max(128)}).parse(request.params);const {projectId}=z.object({projectId:z.uuid()}).parse(request.query);
    const a=await authorize(request,{scope:'read',projectId});
    return tenant(a.organizationId,a.userId,async tx=>{
      const [run]=await rows<any>(tx,sql`select * from runs where project_id=${projectId} and id=${id}`);assert(run,404,'not_found','Run not found.');assert(!run.expired_at,410,'data_expired','The detailed run content expired under your retention policy.');
      return {...run,events:(await rows<any>(tx,sql`select event from events where project_id=${projectId} and run_id=${id} order by event->>'timestamp',event_id`)).map(x=>x.event),evidence:await rows(tx,sql`select id,body,created_at from evidence where project_id=${projectId} and run_id=${id} order by created_at`),evaluations:await rows(tx,sql`select id,revision,policy_id,policy_hash,processing,assessment,created_at,completed_at from evaluations where project_id=${projectId} and run_id=${id} order by created_at desc`),reviews:await rows(tx,sql`select * from reviews where project_id=${projectId} and run_id=${id} order by created_at desc`)};
    });
  });
}
