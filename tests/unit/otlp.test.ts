import { expect,it } from 'vitest';
import { mapOtlp } from '../../apps/api/src/otlp.ts';
it('maps root execution failures without inventing outcomes',()=>{
  const events=mapOtlp([{resource:{attributes:[{key:'service.name',value:{stringValue:'Support agent'}},{key:'service.version',value:{stringValue:'v2'}}]},scopeSpans:[{spans:[{traceId:'1'.repeat(32),spanId:'2'.repeat(16),name:'Agent',startTimeUnixNano:'1793527200000000000',endTimeUnixNano:'1793527201000000000',status:{code:2},attributes:[]}]}]}]);
  expect(events.map(e=>e.kind)).toEqual(['run.started','run.failed']);expect(events[0].payload.agent).toBe('Support agent');expect(events.some(e=>e.payload.outcome)).toBe(false);
});
