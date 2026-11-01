import { beforeAll,afterAll,it,expect } from 'vitest';
import { createHmac,randomUUID } from 'node:crypto';
import { buildServer } from '../../apps/api/src/server.ts';
import { pool } from '@agent-quality/db';
const app=await buildServer();const org='10000000-0000-4000-8000-000000000001',project='20000000-0000-4000-8000-000000000001';
const runId=`receipt-${randomUUID()}`;let verifier='',ingestion='',cookie='';
beforeAll(async()=>{
  const login=await app.inject({method:'POST',url:'/v1/auth/login',payload:{email:'alex@example.test',password:'local-password-123'}});cookie=login.cookies.map(c=>`${c.name}=${c.value}`).join('; ');
  for(const scope of ['verifier','ingest']){const response=await app.inject({method:'POST',url:'/v1/keys',headers:{cookie,'x-workspace-id':org},payload:{projectId:project,name:`Verification ${scope}`,scopes:[scope]}});expect(response.statusCode).toBe(200);if(scope==='verifier')verifier=response.json().secret;else ingestion=response.json().secret;}
  const base={schemaVersion:'1.0',runId,agentVersion:'v1',environment:'test'};const now=new Date().toISOString();
  const response=await app.inject({method:'POST',url:'/v1/events',headers:{authorization:`Bearer ${ingestion}`},payload:{projectId:project,events:[{...base,eventId:`${runId}-start`,kind:'run.started',timestamp:now,payload:{agent:'Receipt test'}},{...base,eventId:`${runId}-end`,kind:'run.completed',timestamp:now,payload:{text:'Updated the contact.'}}]}});expect(response.statusCode).toBe(202);
});
afterAll(async()=>{await app.close();await pool.end();});
const receipt={receiptId:`receipt-${randomUUID()}`,projectId:project,runId,outcomeId:'contact',resourceId:'123',observedAt:new Date().toISOString(),properties:{stage:'customer'},status:'observed'};
function submit(body:unknown,key=verifier,timestamp=String(Math.floor(Date.now()/1000)),valid=true){const raw=JSON.stringify(body);const signature=valid?createHmac('sha256',key).update(`${timestamp}.${raw}`).digest('hex'):'0'.repeat(64);return app.inject({method:'POST',url:'/v1/evidence',headers:{authorization:`Bearer ${key}`,'content-type':'application/json','x-receipt-timestamp':timestamp,'x-receipt-signature':signature},payload:raw});}
it('accepts signed receipts as customer provenance and makes identical replay harmless',async()=>{
  const first=await submit(receipt);expect(first.statusCode).toBe(202);expect(first.json().provenance).toBe('customer_verifier');expect(first.json().revision).toBe(2);
  const duplicate=await submit(receipt);expect(duplicate.statusCode).toBe(202);expect(duplicate.json().duplicate).toBe(true);expect(duplicate.json().revision).toBe(2);
});
it('rejects conflicting receipts, invalid signatures, stale timestamps, and ingestion credentials',async()=>{
  expect((await submit({...receipt,properties:{stage:'lead'}})).statusCode).toBe(409);
  expect((await submit(receipt,verifier,undefined,false)).statusCode).toBe(401);
  expect((await submit(receipt,verifier,'1')).statusCode).toBe(401);
  expect((await submit(receipt,ingestion)).statusCode).toBe(403);
  expect((await submit({...receipt,source:'provider_observation'})).statusCode).toBe(400);
});
it('rejects a forged OAuth callback state',async()=>{
  const response=await app.inject({url:`/v1/connections/github/callback?state=${org}.${project}.forged&code=fake&installation_id=1`,headers:{cookie}});expect(response.statusCode).toBe(400);expect(response.json().error.code).toBe('oauth_state_invalid');
});
