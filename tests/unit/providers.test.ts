import { expect,it } from 'vitest';
import { encrypt,decrypt } from '../../packages/integrations/src/encryption.ts';
import { observe,providerFetch } from '../../packages/integrations/src/providers.ts';
import { expected } from '../fixtures/evaluation.ts';
it('encrypts credentials with workspace/project authenticated context',async()=>{
  const context={organizationId:'northstar',projectId:'support'};const envelope=await encrypt({access_token:'private-token'},context);
  expect(JSON.stringify(envelope)).not.toContain('private-token');expect(await decrypt(envelope,context)).toEqual({access_token:'private-token'});
  await expect(decrypt(envelope,{...context,organizationId:'orbit'})).rejects.toThrow();
});
it('limits outbound provider hosts and prohibits redirects',async()=>{
  await expect(providerFetch('http://127.0.0.1/private')).rejects.toThrow('not allowed');await expect(providerFetch('https://api.github.com.evil.test/')).rejects.toThrow('not allowed');
  let redirect:unknown;await providerFetch('https://api.github.com/repos/example/support/issues/42',{},async(_url,options)=>{redirect=options?.redirect;return new Response('{}');});expect(redirect).toBe('error');
});
it('records only requested GitHub properties with independent observation provenance',async()=>{
  let method:unknown;
  const observation=await observe(expected,'token',async(_url,options)=>{method=options?.method??'GET';return Response.json({number:42,title:'Investigate refund',state:'open',body:'Unrequested content',email:'private@example.test'});});
  expect(method).toBe('GET');expect(observation.source).toBe('provider_observation');expect(observation.properties).toEqual({title:'Investigate refund',state:'open'});expect(JSON.stringify(observation)).not.toContain('Unrequested');
});
it('keeps provider 404 and permission denial unavailable',async()=>{
  const missing=await observe(expected,'token',async()=>new Response('',{status:404}));expect(missing.status).toBe('unavailable');expect(missing.reason).toContain('unknown');
  const denied=await observe(expected,'token',async()=>new Response('',{status:403}));expect(denied.status).toBe('unavailable');
});
it('retrieves only configured HubSpot properties',async()=>{
  let requested='';const observation=await observe({...expected,source:'hubspot',operation:'hubspot.contact.update',resource:{id:'123'},assertions:{lifecyclestage:'customer'}},'token',async url=>{requested=String(url);return Response.json({id:'123',properties:{lifecyclestage:'customer',email:'private@example.test'}});});
  expect(new URL(requested).searchParams.get('properties')).toBe('lifecyclestage');expect(observation.properties).toEqual({lifecyclestage:'customer'});
});
