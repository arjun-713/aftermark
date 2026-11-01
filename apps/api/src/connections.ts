import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenant,rows,sql } from '@agent-quality/db';
import { config } from '../../../packages/db/src/config.ts';
import { encrypt } from '../../../packages/integrations/src/encryption.ts';
import { providerFetch,githubHeaders,exchangeHubspot,connectionToken } from '../../../packages/integrations/src/providers.ts';
import { authorize,digest,userIdentity } from './auth.ts';
import { assert } from './errors.ts';
import { audit } from './management.ts';
export async function connectionRoutes(app:FastifyInstance){
  app.get('/v1/connections',async request=>{
    const {projectId}=z.object({projectId:z.uuid()}).parse(request.query);const a=await authorize(request,{scope:'read',projectId});
    const connections=await tenant(a.organizationId,a.userId,tx=>rows<any>(tx,sql`select id,provider,name,status,last_checked_at,created_at from connections where project_id=${projectId}`));
    return {connections,configuration:{github:Boolean(process.env.GITHUB_APP_ID&&process.env.GITHUB_CLIENT_ID&&process.env.GITHUB_CLIENT_SECRET&&process.env.GITHUB_APP_SLUG&&process.env.GITHUB_APP_PRIVATE_KEY),hubspot:Boolean(process.env.HUBSPOT_CLIENT_ID&&process.env.HUBSPOT_CLIENT_SECRET)}};
  });
  app.post('/v1/connections/:provider/authorize',async(request,reply)=>{
    const {provider}=z.object({provider:z.enum(['github','hubspot'])}).parse(request.params);const {projectId}=z.object({projectId:z.uuid()}).parse(request.body);const a=await authorize(request,{sessionOnly:true,roles:['owner','admin'],projectId});
    assert(provider==='github'?process.env.GITHUB_CLIENT_ID&&process.env.GITHUB_CLIENT_SECRET&&process.env.GITHUB_APP_SLUG&&process.env.GITHUB_APP_ID&&process.env.GITHUB_APP_PRIVATE_KEY:process.env.HUBSPOT_CLIENT_ID&&process.env.HUBSPOT_CLIENT_SECRET,503,'provider_not_configured','This provider has not been configured by the platform operator.');
    const state=`${a.organizationId}.${projectId}.${randomBytes(32).toString('base64url')}`;
    await tenant(a.organizationId,a.userId,tx=>tx.execute(sql`insert into oauth_states(organization_id,project_id,state_hash,provider,user_id,expires_at) values(${a.organizationId},${projectId},${digest(state)},${provider},${a.userId},now()+interval '10 minutes')`));
    reply.setCookie('aq_oauth_state',digest(state),{path:'/',httpOnly:true,secure:config.NODE_ENV==='production',sameSite:'lax',maxAge:600});
    const redirect=`${config.WEB_ORIGIN}/api/v1/connections/${provider}/callback`;
    return {url:provider==='github'?`https://github.com/apps/${process.env.GITHUB_APP_SLUG}/installations/new?state=${encodeURIComponent(state)}`:`https://app.hubspot.com/oauth/authorize?${new URLSearchParams({client_id:process.env.HUBSPOT_CLIENT_ID!,redirect_uri:redirect,scope:'crm.objects.contacts.read',state})}`};
  });
  app.get('/v1/connections/:provider/callback',async(request,reply)=>{
    const {provider}=z.object({provider:z.enum(['github','hubspot'])}).parse(request.params);const q=z.object({state:z.string().max(300),code:z.string().min(1).max(1000),installation_id:z.coerce.number().int().positive().optional()}).parse(request.query);
    const [org,projectId]=q.state.split('.');z.uuid().parse(org);z.uuid().parse(projectId);
    assert(request.cookies.aq_oauth_state===digest(q.state),400,'oauth_state_invalid','The provider authorization state is invalid or expired.');
    request.headers['x-workspace-id']=org;const a=await authorize(request,{sessionOnly:true,roles:['owner','admin'],projectId});
    await tenant(org,a.userId,async tx=>{const states=await rows(tx,sql`delete from oauth_states where state_hash=${digest(q.state)} and provider=${provider} and user_id=${a.userId} and expires_at>now() returning state_hash`);assert(states.length,400,'oauth_state_invalid','The provider authorization state is invalid or already used.');});
    let credential:unknown,name:string;
    const redirect=`${config.WEB_ORIGIN}/api/v1/connections/${provider}/callback`;
    if(provider==='hubspot'){const token=await exchangeHubspot({grant_type:'authorization_code',code:q.code,redirect_uri:redirect});credential=token;name=`HubSpot account ${token.hub_id??'connected'}`;}
    else{
      assert(q.installation_id,400,'installation_required','GitHub must return the installation ID with user authorization.');
      const response=await fetch('https://github.com/login/oauth/access_token',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({client_id:process.env.GITHUB_CLIENT_ID,client_secret:process.env.GITHUB_CLIENT_SECRET,code:q.code,redirect_uri:redirect}),redirect:'error',signal:AbortSignal.timeout(8000)});
      assert(response.ok,502,'github_authorization_failed','GitHub authorization failed.');const {access_token}=z.object({access_token:z.string().min(1)}).parse(await response.json());
      let found:any;
      for(let page=1;page<=10&&!found;page++){const listing=await providerFetch(`https://api.github.com/user/installations?per_page=100&page=${page}`,{headers:githubHeaders(access_token)});assert(listing.ok,403,'installation_access_denied','GitHub installation access could not be confirmed.');const data=await listing.json() as any;found=data.installations?.find((i:any)=>i.id===q.installation_id&&String(i.app_id)===process.env.GITHUB_APP_ID);if((data.installations?.length??0)<100)break;}
      assert(found && found.permissions?.issues==='read' && !Object.values(found.permissions).includes('write'),403,'read_only_required','Connect an accessible GitHub App installation with read-only Issues permissions.');credential={installationId:q.installation_id};name=String(found.account?.login??'GitHub installation');
    }
    const envelope=await encrypt(credential,{organizationId:org,projectId});
    await tenant(org,a.userId,async tx=>{const [connection]=await rows<any>(tx,sql`insert into connections(organization_id,project_id,provider,name,credential) values(${org},${projectId},${provider},${name},${JSON.stringify(envelope)}::jsonb) on conflict(organization_id,project_id,provider) do update set name=excluded.name,credential=excluded.credential,status='connected' returning id`);await audit(tx,org,a.userId,'connection.authorized',connection.id);});
    reply.clearCookie('aq_oauth_state',{path:'/'});return reply.redirect(`${config.WEB_ORIGIN}/app/connections?connected=${provider}`);
  });
  app.post('/v1/connections/:id/check',async request=>{
    const {id}=z.object({id:z.uuid()}).parse(request.params);const {projectId}=z.object({projectId:z.uuid()}).parse(request.body);const a=await authorize(request,{sessionOnly:true,roles:['owner','admin'],projectId});
    const [connection]=await tenant(a.organizationId,a.userId,tx=>rows<any>(tx,sql`select * from connections where project_id=${projectId} and id=${id}`));assert(connection,404,'not_found','Connection not found.');
    let status='disconnected';try{const token=await connectionToken(connection,{organizationId:a.organizationId,projectId});const response=await providerFetch(connection.provider==='github'?'https://api.github.com/installation/repositories?per_page=1':'https://api.hubapi.com/crm/v3/objects/contacts?limit=1&properties=hs_object_id',{headers:connection.provider==='github'?githubHeaders(token):{Authorization:`Bearer ${token}`}});if(response.ok)status='connected';}catch{/* Preserve the disconnected state. */}
    await tenant(a.organizationId,a.userId,tx=>tx.execute(sql`update connections set status=${status},last_checked_at=now() where project_id=${projectId} and id=${id}`));return {status,checkedAt:new Date().toISOString()};
  });
  app.delete('/v1/connections/:id',async request=>{
    const {id}=z.object({id:z.uuid()}).parse(request.params);const {projectId}=z.object({projectId:z.uuid()}).parse(request.query);const a=await authorize(request,{sessionOnly:true,roles:['owner','admin'],projectId});
    return tenant(a.organizationId,a.userId,async tx=>{const changed=await rows(tx,sql`delete from connections where project_id=${projectId} and id=${id} returning id`);assert(changed.length,404,'not_found','Connection not found.');await audit(tx,a.organizationId,a.userId,'connection.disconnected',id);return {ok:true};});
  });
}
