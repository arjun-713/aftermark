import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { tenant,rows,sql, type Tx } from '@agent-quality/db';
import { defaultPolicy,plans } from '@agent-quality/contracts';
import { authorize,digest,userIdentity } from './auth.ts';
import { assert } from './errors.ts';
export const audit=(tx:Tx,org:string,uid:string|null,action:string,resourceId:string)=>tx.execute(sql`insert into audit_events(organization_id,user_id,action,resource_id) values(${org},${uid},${action},${resourceId})`);
export async function managementRoutes(app:FastifyInstance) {
  app.post('/v1/workspaces',async request=>{
    const uid=await userIdentity(request); const {name}=z.object({name:z.string().min(1).max(120)}).parse(request.body);
    return tenant('',uid,async tx=>{ const [org]=await rows<any>(tx,sql`select create_workspace(${uid},${name}) as id`); return {id:org.id,name}; });
  });
  app.get('/v1/projects',async request=>{
    const a=await authorize(request,{scope:'read'});
    return tenant(a.organizationId,a.userId,tx=>rows(tx,sql`select id,name,created_at,active_policy_id from projects where (${a.projectId}::uuid is null or id=${a.projectId}::uuid) order by created_at`));
  });
  app.post('/v1/projects',async request=>{
    const a=await authorize(request,{roles:['owner','admin'],sessionOnly:true}); const {name}=z.object({name:z.string().min(1).max(120)}).parse(request.body);
    return tenant(a.organizationId,a.userId,async tx=>{
      const [sub]=await rows<any>(tx,sql`select * from subscriptions where organization_id=${a.organizationId} for update`);
      assert(['active','trialing'].includes(sub.status)&&Date.parse(sub.period_end)>Date.now(),402,'subscription_inactive','An active subscription or trial is required to create a project.');
      const [{count}]=await rows<any>(tx,sql`select count(*)::int as count from projects`);
      assert(count<plans[sub.plan as keyof typeof plans].projects,402,'project_limit','The workspace project allowance is exhausted.');
      const [project]=await rows<any>(tx,sql`insert into projects(organization_id,name) values(${a.organizationId},${name}) returning id,name`);
      const [policy]=await rows<any>(tx,sql`insert into policies(organization_id,project_id,version,definition,hash,created_by) values(${a.organizationId},${project.id},1,${JSON.stringify(defaultPolicy)}::jsonb,${digest(JSON.stringify(defaultPolicy))},${a.userId}) returning id`);
      await tx.execute(sql`update projects set active_policy_id=${policy.id} where id=${project.id}`);
      await audit(tx,a.organizationId,a.userId,'project.created',project.id);return project;
    });
  });
  app.get('/v1/keys',async request=>{
    const a=await authorize(request,{roles:['owner','admin'],sessionOnly:true});
    return tenant(a.organizationId,a.userId,tx=>rows(tx,sql`select id,project_id,name,prefix,scopes,created_at,revoked_at from api_keys order by created_at desc`));
  });
  app.post('/v1/keys',async request=>{
    const body=z.object({projectId:z.uuid(),name:z.string().min(1).max(100),scopes:z.array(z.enum(['ingest','read','evaluate','ci','verifier'])).min(1).max(5)}).parse(request.body);
    const a=await authorize(request,{roles:['owner','admin'],sessionOnly:true,projectId:body.projectId});
    assert(!(body.scopes.includes('verifier') && body.scopes.length>1),400,'separate_verifier_key','Verifier credentials must have only the verifier scope.');
    const key=`aq_${randomBytes(32).toString('base64url')}`;
    return tenant(a.organizationId,a.userId,async tx=>{
      const [record]=await rows(tx,sql`insert into api_keys(organization_id,project_id,name,prefix,secret_hash,scopes) values(${a.organizationId},${body.projectId},${body.name},${key.slice(0,11)},${digest(key)},ARRAY[${sql.join(body.scopes.map(s=>sql`${s}`),sql`, `)}]::text[]) returning id,name,prefix,scopes`);
      await audit(tx,a.organizationId,a.userId,'key.created',String(record.id)); return {...record,secret:key};
    });
  });
  app.delete('/v1/keys/:id',async request=>{
    const a=await authorize(request,{roles:['owner','admin'],sessionOnly:true}); const {id}=z.object({id:z.uuid()}).parse(request.params);
    return tenant(a.organizationId,a.userId,async tx=>{const changed=await rows(tx,sql`update api_keys set revoked_at=now() where id=${id} and revoked_at is null returning id`); assert(changed.length,404,'not_found','Active key not found.'); await audit(tx,a.organizationId,a.userId,'key.revoked',id);return {ok:true};});
  });
  app.get('/v1/usage',async request=>{
    const a=await authorize(request,{scope:'read'});
    return tenant(a.organizationId,a.userId,async tx=>{
      const [subscription]=await rows<any>(tx,sql`select plan,status,allowance,period_start,period_end,provider_id,customer_id from subscriptions`);
      const [usage]=await rows<any>(tx,sql`select coalesce(sum(units) filter(where state='consumed'),0)::int as consumed,coalesce(sum(units) filter(where state in('reserved','ambiguous')),0)::int as reserved,coalesce(sum(tokens),0)::int as tokens from usage_ledger where created_at >= ${subscription.period_start}`);
      return {subscription,...usage,remaining:Math.max(0,subscription.allowance-usage.consumed-usage.reserved)};
    });
  });
}
