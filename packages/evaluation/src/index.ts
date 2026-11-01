import { createHash } from 'node:crypto';
import { type AgentEvent,type Outcome,type Evidence,type Assessment,type Policy,type Finding } from '@agent-quality/contracts';
import { canonical } from '../../contracts/src/redaction.ts';
export type FrozenRun={id:string;revision:number;executionStatus:string;startedAt:string;completedAt:string|null;events:AgentEvent[];evidence:Evidence[];policy:Policy;calibrationApproved?:boolean};
export type SemanticResult={model:string;usage:number;probabilities:Record<string,number>};
export function readPath(value:unknown,path:string):unknown {
  for(const key of path.split('.')){if(['__proto__','constructor','prototype'].includes(key) || !value || typeof value!=='object' || !Object.hasOwn(value,key))return undefined;value=(value as Record<string,unknown>)[key];}return value;
}
const redacted=(v:unknown)=>v===undefined || /\[(REDACTED|TRUNCATED)/.test(JSON.stringify(v)??'');
export function expectedOutcomes(input:FrozenRun):Outcome[] {
  const result=new Map<string,Outcome>();
  for(const e of input.events)if(e.kind==='outcome.expected' && e.payload.outcome)result.set(e.payload.outcome.id,e.payload.outcome);
  for(const mapping of input.policy.toolMappings){
    if(!input.events.some(e=>e.kind==='tool.called' && e.payload.tool===mapping.tool))continue;
    const outcome=structuredClone(result.get(mapping.outcome.id)??mapping.outcome);
    if(!outcome.resource.id && outcome.resource.toolResultField){const last=input.events.filter(e=>e.kind==='tool.result' && e.payload.tool===mapping.tool && e.payload.success).at(-1);const id=readPath(last?.payload.result,outcome.resource.toolResultField);if(typeof id==='number' || typeof id==='string')outcome.resource.id=String(id);}
    result.set(outcome.id,outcome);
  }
  return [...result.values()];
}
export function assess(input:FrozenRun,semantic?:SemanticResult,semanticError?:string):Assessment {
  const findings:Finding[]=[],limitations:string[]=[];
  const add=(code:string,summary:string,options:Partial<Finding>={})=>findings.push({id:createHash('sha256').update(canonical({code,summary,...options})).digest('hex').slice(0,24),code,summary,severity:'medium',evidenceIds:[],blocking:false,...options});
  const events=[...input.events].sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp)||a.eventId.localeCompare(b.eventId));
  const terminal=events.findLast(e=>['run.completed','run.failed','run.cancelled'].includes(e.kind));
  if(!events.some(e=>e.kind==='run.started'))limitations.push('The run start event is missing.');
  if(!terminal || input.executionStatus==='running')limitations.push('No completed execution boundary is recorded.');
  if(events.some(e=>e.payload.metadata?.truncated || e.payload.text?.includes('[TRUNCATED')))limitations.push('Part of the trace was truncated before evaluation.');
  const spanIds=new Set(events.filter(e=>e.kind==='span.started').map(e=>e.spanId));
  if(events.some(e=>e.parentSpanId && !spanIds.has(e.parentSpanId)))limitations.push('A parent span is missing.');
  if(events.some(e=>e.kind==='span.started' && !events.some(end=>end.kind==='span.completed' && end.spanId===e.spanId)))limitations.push('A span has no closing event.');
  const calls=events.filter(e=>e.kind==='tool.called');const results=events.filter(e=>e.kind==='tool.result');
  if(calls.some(c=>!results.some(r=>r.payload.toolCallId===c.payload.toolCallId)))limitations.push('A tool call has no recorded result.');
  if(results.some(r=>!calls.some(c=>r.payload.toolCallId===c.payload.toolCallId)))limitations.push('A tool result has no recorded call.');
  const expectations=expectedOutcomes({...input,events});
  if(!expectations.length)limitations.push('No explicit expected outcomes are configured. Verified completion is unavailable.');
  const duplicateOutcomes=new Map<string,string>();
  for(const e of events)if(e.payload.outcome){const old=duplicateOutcomes.get(e.payload.outcome.id);const next=canonical(e.payload.outcome);if(old && old!==next)limitations.push(`Outcome ${e.payload.outcome.id} has conflicting definitions.`);duplicateOutcomes.set(e.payload.outcome.id,next);}
  const outcomes:Assessment['outcomes']=expectations.map(outcome=>{
    const base={id:outcome.id,name:outcome.name,required:outcome.required};
    if(!outcome.resource.id || redacted(outcome.resource.id))return {...base,verification:'unknown',evidenceIds:[],reason:'The expected resource identifier is unavailable.'};
    const observations=input.evidence.filter(e=>e.outcomeId===outcome.id && e.resourceId===outcome.resource.id && (e.source==='customer_verifier' && outcome.source==='customer_verifier' || e.source==='provider_observation' && e.provider===outcome.source)).sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt));
    const completed=input.completedAt?Date.parse(input.completedAt):NaN;
    const applicable=observations.filter(e=>Number.isFinite(completed) && Date.parse(e.observedAt)>=completed && Date.parse(e.observedAt)-completed<=outcome.observationWindowSeconds*1000);
    const evidence=applicable.find(e=>e.status==='observed');
    if(!evidence)return {...base,verification:'unknown',evidenceIds:observations.map(e=>e.id),reason:observations.length?'The observation is unavailable or outside the acceptable window.':'No independent observation is available. Reported tool results do not verify external state.'};
    const assertions=Object.entries(outcome.assertions);
    if(!assertions.length || assertions.some(([key,expected])=>redacted(expected)||redacted(readPath(evidence.properties,key))))return {...base,verification:'unknown',evidenceIds:[evidence.id],reason:'An essential property is missing or redacted.'};
    const mismatches=assertions.filter(([key,expected])=>canonical(readPath(evidence.properties,key))!==canonical(expected));
    const verification=mismatches.length?'contradicted' as const:'verified' as const;
    if(mismatches.length)add('outcome_contradicted',`Observed properties contradict “${outcome.name}”: ${mismatches.map(([key])=>key).join(', ')}.`,{severity:outcome.required?'high':'medium',blocking:outcome.required,evidenceIds:[evidence.id],outcomeId:outcome.id});
    return {...base,verification,evidenceIds:[evidence.id],reason:mismatches.length?'Required properties did not match the recorded observation.':'Required properties matched the observation at its recorded time; historical causality is not established.'};
  });
  for(const o of outcomes)if(o.required && o.verification==='unknown')add('outcome_unverified',`Required outcome “${o.name}” remains unverified.`,{outcomeId:o.id,evidenceIds:o.evidenceIds});
  for(const failed of results.filter(r=>r.payload.success===false)){
    const call=calls.find(c=>c.payload.toolCallId===failed.payload.toolCallId);
    const recovered=results.some(r=>r.payload.success===true && r.payload.tool===failed.payload.tool && Date.parse(r.timestamp)>Date.parse(failed.timestamp) && canonical(calls.find(c=>c.payload.toolCallId===r.payload.toolCallId)?.payload.arguments??{})===canonical(call?.payload.arguments??{}));
    if(!recovered)add('tool_failure',`Tool “${failed.payload.tool}” failed without a recorded successful retry.`,{evidenceIds:[failed.eventId]});
  }
  const repetition=new Map<string,AgentEvent[]>();
  for(const c of calls){const key=canonical([c.payload.tool,c.payload.arguments]);const group=repetition.get(key)??[];group.push(c);repetition.set(key,group);}
  for(const group of repetition.values())if(group.length>=3){const outcomes=group.map(c=>results.find(r=>r.payload.toolCallId===c.payload.toolCallId)?.payload.result);if(new Set(outcomes.map(canonical)).size===1)add('repeated_actions',`${group.length} identical calls to “${group[0].payload.tool}” have no recorded change in result. Review whether this was intentional polling.`,{evidenceIds:group.map(c=>c.eventId)});}
  const requiresSemantic=input.policy.semanticEnabled && input.policy.checks.length>0;
  if(requiresSemantic){
    if(semanticError || !semantic)limitations.push(semanticError??'Semantic checks did not return a validated result.');
    else for(const check of input.policy.checks){
      const yes=semantic.probabilities[check.id];
      if(yes===undefined){limitations.push(`Semantic answer ${check.id} is missing.`);continue;}
      const violation=['failure_acknowledged','requirement'].includes(check.type)?1-yes:yes;
      if(violation>=check.threshold)add(`semantic_${check.type}`,`Check “${check.id}” flagged the frozen run context. Inspect the linked trace before deciding.`,{severity:input.calibrationApproved?'high':'medium',blocking:Boolean(input.calibrationApproved && input.policy.semanticBlocking && check.blocking),probability:violation,evidenceIds:events.filter(e=>e.kind==='message'||e.kind==='run.completed').map(e=>e.eventId)});
      else if(violation>1-check.threshold)add('semantic_uncertain',`Check “${check.id}” is uncertain and needs human review.`,{probability:violation});
    }
  }
  const meaningful=events.some(e=>e.kind==='tool.result' || e.payload.text && !/^\s*(placeholder|lorem ipsum|test|n\/a|\[REDACTED\])\s*$/i.test(e.payload.text));
  if(!meaningful)limitations.push('The trace contains no substantive evaluation context.');
  const required=outcomes.filter(o=>o.required);
  const verifiedCompletion=input.executionStatus==='completed' && required.length>0 && required.every(o=>o.verification==='verified') && !limitations.length;
  const decision=findings.some(f=>f.blocking)?'fail':limitations.length || required.some(o=>o.verification==='unknown')?'unknown':findings.length?'review':verifiedCompletion?'pass':'unknown';
  return {processing:limitations.length?'partial':'completed',decision,outcomes,findings,limitations:[...new Set(limitations)],verifiedCompletion,model:semantic?.model??null,usage:semantic?.usage??0};
}
