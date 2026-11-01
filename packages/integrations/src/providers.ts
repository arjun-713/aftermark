import { randomUUID } from 'node:crypto';
import { createAppAuth } from '@octokit/auth-app';
import { z } from 'zod';
import { type Outcome,type Evidence,type ConnectionBinding } from '../../contracts/src/index.ts';
import { redact } from '../../contracts/src/redaction.ts';
import { readPath,expectedOutcomes,type FrozenRun } from '../../evaluation/src/index.ts';
import { connectionBinding,resourceIdentity } from '../../evaluation/src/identity.ts';
import { tenant,rows,sql } from '@agent-quality/db';
import { encrypt,decrypt,type Envelope } from './encryption.ts';
import type { RunJob } from '../../db/src/queue.ts';
import { readBoundedJson } from './http.ts';
const hosts=new Set(['api.github.com','api.hubapi.com','api.hubspot.com']);
export async function providerFetch(url:string,init:RequestInit={},transport:typeof fetch=fetch){
  const parsed=new URL(url);if(parsed.protocol!=='https:' || !hosts.has(parsed.hostname)||parsed.username||parsed.password||parsed.port&&parsed.port!=='443')throw new Error('Provider request host is not allowed');
  return transport(parsed,{...init,redirect:'error',signal:AbortSignal.timeout(8000)});
}
export const githubHeaders=(token:string)=>({Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'});
export const hubspotTokenSchema=z.object({access_token:z.string().min(1),refresh_token:z.string().min(1),expires_in:z.number().positive(),scopes:z.array(z.string()),hub_id:z.number().optional()});
export async function exchangeHubspot(parameters:Record<string,string>,transport:typeof fetch=fetch){
  const response=await providerFetch('https://api.hubspot.com/oauth/v3/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...parameters,client_id:process.env.HUBSPOT_CLIENT_ID!,client_secret:process.env.HUBSPOT_CLIENT_SECRET!})},transport);
  if(!response.ok)throw new Error('HubSpot authorization failed');const token=hubspotTokenSchema.parse(await readBoundedJson(response));
  if(!token.scopes.includes('crm.objects.contacts.read')||token.scopes.some(s=>!['oauth','crm.objects.contacts.read'].includes(s)))throw new Error('HubSpot connection must have only contact read permissions');return {...token,expiresAt:Date.now()+token.expires_in*1000};
}
type HubspotCredential=z.infer<typeof hubspotTokenSchema>&{expiresAt:number};
export async function connectionToken(connection:any,job:Pick<RunJob,'organizationId'|'projectId'>):Promise<string>{
  const context={organizationId:job.organizationId,projectId:job.projectId};
  const credential=await decrypt<any>(connection.credential as Envelope,context);
  if(connection.provider==='github'){
    if(!process.env.GITHUB_APP_ID || !process.env.GITHUB_APP_PRIVATE_KEY)throw new Error('GitHub App is not configured');
    const auth=createAppAuth({appId:process.env.GITHUB_APP_ID,privateKey:process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g,'\n'),installationId:credential.installationId});
    return (await auth({type:'installation',permissions:{issues:'read',metadata:'read'}})).token;
  }
  if(credential.expiresAt>Date.now()+60000)return credential.access_token;
  // Serialize refreshes across workers and projects sharing the same connection record.
  return tenant(job.organizationId,null,async tx=>{
    const [fresh]=await rows<any>(tx,sql`select credential,verification_version from connections where project_id=${job.projectId} and id=${connection.id} for update`);
    if(!fresh || fresh.verification_version!==connection.verification_version)throw new Error('The provider connection changed after this evaluation was frozen');
    const current=await decrypt<HubspotCredential>(fresh.credential,context);if(current.expiresAt>Date.now()+60000)return current.access_token;
    const token=await exchangeHubspot({grant_type:'refresh_token',refresh_token:current.refresh_token});
    if(current.hub_id!==undefined && token.hub_id!==undefined && current.hub_id!==token.hub_id)throw new Error('Provider token refresh changed account identity');
    const envelope=await encrypt(token,context);await tx.execute(sql`update connections set credential=${JSON.stringify(envelope)}::jsonb,status='connected' where project_id=${job.projectId} and id=${connection.id}`);return token.access_token;
  });
}
export async function observe(outcome:Outcome,token:string,transport:typeof fetch=fetch,binding?:ConnectionBinding):Promise<Evidence>{
  const identity=resourceIdentity(outcome);
  const base:Evidence={id:randomUUID(),outcomeId:outcome.id,source:'provider_observation',provider:outcome.source,observedAt:new Date().toISOString(),resourceId:outcome.resource.id??'',status:'unavailable',properties:{},resourceIdentity:identity,connectionBinding:binding};
  if(!identity || !binding)return {...base,reason:'A frozen resource and provider connection binding are required.'};
  try{
    let url:string;
    if(outcome.source==='github'){
      if(!outcome.resource.repository || !/^\d+$/.test(outcome.resource.id??''))return {...base,reason:'A repository and numeric issue number are required.'};
      url=`https://api.github.com/repos/${outcome.resource.repository}/issues/${outcome.resource.id}`;
    }else if(outcome.source==='hubspot'){
      if(!outcome.resource.id)return {...base,reason:'A contact ID is required.'};
      const props=Object.keys(outcome.assertions);if(props.some(p=>!/^[a-zA-Z0-9_]+$/.test(p)))return {...base,reason:'Contact property names are invalid.'};
      const params=new URLSearchParams({properties:props.join(','),archived:'false'});
      url=`https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(outcome.resource.id)}?${params}`;
    }else return {...base,reason:'A customer-operated verifier receipt is required.'};
    let response:Response|undefined;
    for(let attempt=0;attempt<3;attempt++){
      response=await providerFetch(url,{headers:outcome.source==='github'?githubHeaders(token):{Authorization:`Bearer ${token}`}},transport);
      if(response.ok || ![404,429,500,502,503,504].includes(response.status))break;
      if(attempt<2)await new Promise(resolve=>setTimeout(resolve,100*2**attempt));
    }
    base.observedAt=new Date().toISOString();
    if(!response?.ok)return {...base,reason:response?.status===404?'The provider did not expose this record after bounded retries. Absence or access restrictions remain unknown.':`Provider observation unavailable (HTTP ${response?.status??'unknown'}).`};
    const data=await readBoundedJson(response) as any;
    if(outcome.source==='github' && (data.pull_request || String(data.number)!==outcome.resource.id) || outcome.source==='hubspot' && String(data.id)!==outcome.resource.id)return {...base,reason:'The provider response did not identify the expected resource type or ID.'};
    const properties=outcome.source==='github'?data:data.properties;
    return {...base,status:'observed',properties:redact(Object.fromEntries(Object.keys(outcome.assertions).map(key=>[key,readPath(properties,key)])))};
  }catch{return {...base,observedAt:new Date().toISOString(),reason:'Provider access or response validation failed.'};}
}
export async function collectEvidence(input:FrozenRun,job:RunJob):Promise<Evidence[]>{
  const outcomes=expectedOutcomes(input).filter(o=>o.source!=='customer_verifier');
  const connections=await tenant(job.organizationId,null,tx=>rows<any>(tx,sql`select * from connections where project_id=${job.projectId} and status in('connected','degraded')`));
  const tokens=new Map<string,Promise<string>>();
  const result:Evidence[]=[];
  for(let i=0;i<outcomes.length;i+=3){
    const observations=await Promise.all(outcomes.slice(i,i+3).map(async outcome=>{
      const expected=input.verificationBindings?.[outcome.id];
      const unavailable=(reason:string):Evidence=>({id:randomUUID(),outcomeId:outcome.id,source:'provider_observation',provider:outcome.source,observedAt:new Date().toISOString(),resourceId:outcome.resource.id??'',status:'unavailable',properties:{},reason,resourceIdentity:expected?.resourceIdentity,connectionBinding:expected?.connectionBinding});
      if(outcomes.length>12)return unavailable('The run exceeds the standard verification budget. Explicit larger analysis is required.');
      if(!expected)return unavailable('This frozen evaluation has no current provider connection binding.');
      const connection=connections.find(c=>c.provider===outcome.source && c.id===expected.connectionBinding.connectionId && c.verification_version===expected.connectionBinding.verificationVersion);
      if(!connection)return unavailable('The frozen provider connection is disconnected or was reauthorized.');
      const binding=connectionBinding(connection)!;
      try{if(!tokens.has(connection.id))tokens.set(connection.id,connectionToken(connection,job));const token=await tokens.get(connection.id)!;const observation=await observe(outcome,token,fetch,binding);await tenant(job.organizationId,null,tx=>tx.execute(sql`update connections set last_checked_at=now(),status=${observation.status==='observed'?'connected':'degraded'} where project_id=${job.projectId} and id=${connection.id} and verification_version=${binding.verificationVersion}`));return observation;}
      catch{await tenant(job.organizationId,null,tx=>tx.execute(sql`update connections set status='disconnected',last_checked_at=now() where project_id=${job.projectId} and id=${connection.id} and verification_version=${binding.verificationVersion}`));return unavailable('Provider credentials are expired or unavailable.');}
    }));result.push(...observations);
  }
  return result;
}
