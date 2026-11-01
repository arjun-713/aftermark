import { z } from 'zod';
import { eventSchema,type AgentEvent } from '@agent-quality/contracts';
const value=z.object({stringValue:z.string().optional(),intValue:z.union([z.string(),z.number()]).optional(),boolValue:z.boolean().optional()}).passthrough();
const attributes=z.array(z.object({key:z.string(),value})).default([]);
const span=z.object({traceId:z.string().regex(/^[a-fA-F0-9]{32}$/),spanId:z.string().regex(/^[a-fA-F0-9]{16}$/),parentSpanId:z.string().regex(/^[a-fA-F0-9]{16}$/).optional(),name:z.string().max(160),startTimeUnixNano:z.string().regex(/^\d+$/),endTimeUnixNano:z.string().regex(/^\d+$/),attributes,status:z.object({code:z.number().optional(),message:z.string().optional()}).optional()});
const resourceSpan=z.object({resource:z.object({attributes}).optional(),scopeSpans:z.array(z.object({spans:z.array(span)}))});
const attrs=(a:z.infer<typeof attributes>)=>Object.fromEntries(a.map(x=>[x.key,x.value.stringValue??x.value.intValue??x.value.boolValue]));
const time=(nano:string)=>new Date(Number(BigInt(nano)/1000000n)).toISOString();
export function mapOtlp(input:unknown[]):AgentEvent[] {
  const out:AgentEvent[]=[];
  for(const resource of z.array(resourceSpan).parse(input)) {
    const r=attrs(resource.resource?.attributes??[]);
    for(const scope of resource.scopeSpans)for(const s of scope.spans){
      const a=attrs(s.attributes);const base={schemaVersion:'1.0' as const,runId:s.traceId,spanId:s.spanId,parentSpanId:s.parentSpanId,agentVersion:String(r['service.version']??'unknown'),environment:['production','staging','test'].includes(String(r['deployment.environment.name']))?r['deployment.environment.name']:'production'};
      out.push(eventSchema.parse({...base,eventId:`${s.spanId}:start`,kind:s.parentSpanId?'span.started':'run.started',timestamp:time(s.startTimeUnixNano),payload:{agent:String(r['service.name']??'Imported agent'),name:s.name,metadata:{mapping:'otlp-json-v1'}}}));
      out.push(eventSchema.parse({...base,eventId:`${s.spanId}:end`,kind:s.parentSpanId?'span.completed':s.status?.code===2?'run.failed':'run.completed',timestamp:time(s.endTimeUnixNano),payload:{name:s.name,success:s.status?.code!==2,text:String(a['gen_ai.output.messages']??a['output.value']??s.status?.message??''),metadata:{mapping:'otlp-json-v1'}}}));
    }
  }return out;
}
