import { expect,it } from 'vitest';
import { AgentQuality } from '../../packages/sdk-typescript/src/index.ts';
it('redacts before transport and preserves nested context and outcomes',async()=>{
  const delivered:any[]=[];
  const sdk=new AgentQuality({endpoint:'http://localhost',projectId:'20000000-0000-4000-8000-000000000001',apiKey:'test',agent:'Support agent',agentVersion:'v1',transport:async(_url,options)=>{delivered.push(...JSON.parse(String(options!.body)).events);return new Response('{}',{status:202});}});
  await sdk.run(async()=>{await sdk.span('Nested work',async()=>{await sdk.tool('github.createIssue',{email:'private@example.test'},async()=>({number:42}));});return 'Created the issue for private@example.test';},{runId:'run-1'});await sdk.close();
  expect(delivered.every(e=>e.runId==='run-1')).toBe(true);expect(delivered.find(e=>e.kind==='tool.result').spanId).toBeTruthy();expect(JSON.stringify(delivered)).not.toContain('private@example.test');expect(sdk.counters.delivered).toBe(delivered.length);
});
it('isolates telemetry failures and bounds the buffer',async()=>{
  const sdk=new AgentQuality({endpoint:'http://localhost',projectId:'20000000-0000-4000-8000-000000000001',apiKey:'test',agent:'Agent',agentVersion:'v1',maxBuffer:2,transport:async()=>{throw new Error('offline');}});
  const result=await sdk.run(async()=>{sdk.message('message');return 42;});await sdk.close();expect(result).toBe(42);expect(sdk.counters.dropped).toBe(3);expect(sdk.counters.retries).toBe(2);
});
