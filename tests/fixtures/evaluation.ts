import { eventSchema,defaultPolicy,type Evidence,type Outcome } from '@agent-quality/contracts';
import type { FrozenRun } from '../../packages/evaluation/src/index.ts';
export const expected:Outcome={id:'issue',name:'Support issue created',operation:'github.issue.create',source:'github',required:true,resource:{repository:'example/support',id:'42'},assertions:{title:'Investigate refund',state:'open'},observationWindowSeconds:300};
export const observed:Evidence={id:'observation-1',outcomeId:'issue',source:'provider_observation',provider:'github',resourceId:'42',observedAt:'2026-11-01T10:00:10Z',status:'observed',properties:{title:'Investigate refund',state:'open'}};
export function makeFrozen():FrozenRun {
  const event=(eventId:string,kind:string,payload:unknown,time:string)=>eventSchema.parse({schemaVersion:'1.0',eventId,runId:'run-1',kind,timestamp:`2026-11-01T10:00:${time}Z`,agentVersion:'v1',environment:'test',payload});
  return {id:'run-1',revision:1,executionStatus:'completed',startedAt:'2026-11-01T10:00:00Z',completedAt:'2026-11-01T10:00:05Z',policy:structuredClone(defaultPolicy),evidence:[structuredClone(observed)],events:[event('start','run.started',{agent:'Support agent'},'00'),event('expect','outcome.expected',{outcome:expected},'01'),event('call','tool.called',{tool:'github.createIssue',toolCallId:'call-1',arguments:{title:'Investigate refund'}},'02'),event('result','tool.result',{tool:'github.createIssue',toolCallId:'call-1',success:true,result:{number:42}},'03'),event('end','run.completed',{text:'Created the support issue.'},'05')]};
}
