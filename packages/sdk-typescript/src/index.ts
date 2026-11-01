import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID,createHmac } from 'node:crypto';
import { eventSchema,type AgentEvent,type Outcome } from '@agent-quality/contracts';
import { canonical,redact } from '../../contracts/src/redaction.ts';
export type Counters={delivered:number;dropped:number;retries:number;truncated:number;deliveryFailures:number};
type Context={runId:string;spanId?:string;parentSpanId?:string};
export class AgentQuality {
  readonly counters:Counters={delivered:0,dropped:0,retries:0,truncated:0,deliveryFailures:0};
  private buffer:AgentEvent[]=[]; private context=new AsyncLocalStorage<Context>();private flushing?:Promise<void>;private timer:ReturnType<typeof setInterval>;
  constructor(private options:{endpoint:string;apiKey:string;projectId:string;agent:string;agentVersion:string;environment?:'production'|'staging'|'test';maxBuffer?:number;flushIntervalMs?:number;transport?:typeof fetch}) {
    this.timer=setInterval(()=>{void this.flush();},options.flushIntervalMs??1000);this.timer.unref();
  }
  emit(kind:AgentEvent['kind'],payload:AgentEvent['payload'],context=this.context.getStore()):void {
    try {
      if(!context){this.counters.dropped++;return;}
      const clean=redact(JSON.parse(JSON.stringify(payload)));
      if(clean.text && clean.text.length>32000){clean.text=clean.text.slice(0,31960)+' [TRUNCATED]';this.counters.truncated++;}
      let event=eventSchema.parse({schemaVersion:'1.0',eventId:randomUUID(),runId:context.runId,spanId:context.spanId,parentSpanId:context.parentSpanId,kind,timestamp:new Date().toISOString(),agentVersion:this.options.agentVersion,environment:this.options.environment??'production',payload:clean});
      if(Buffer.byteLength(JSON.stringify(event))>128000){this.counters.truncated++;if(kind==='outcome.expected'){this.counters.dropped++;return;}event={...event,payload:{tool:clean.tool,toolCallId:clean.toolCallId,success:clean.success,text:'[TRUNCATED: oversized event payload]',metadata:{truncated:true}}};}
      if(this.buffer.length>=(this.options.maxBuffer??1000)){this.counters.dropped++;return;}
      this.buffer.push(event);
    } catch {this.counters.dropped++;}
  }
  async run<T>(fn:()=>Promise<T>,options:{runId?:string;outcomes?:Outcome[]}={}):Promise<T> {
    return this.context.run({runId:options.runId??randomUUID()},async()=>{
      this.emit('run.started',{agent:this.options.agent});for(const outcome of options.outcomes??[])this.expect(outcome);
      try {const result=await fn();this.emit('run.completed',{text:typeof result==='string'?result:undefined});return result;}
      catch(error){this.emit('run.failed',{text:error instanceof Error?error.message:'Agent execution failed.'});throw error;}
    });
  }
  expect(outcome:Outcome){this.emit('outcome.expected',{outcome});}
  message(text:string){this.emit('message',{text});}
  async span<T>(name:string,fn:()=>Promise<T>):Promise<T> {
    const parent=this.context.getStore();if(!parent)return fn();
    const spanId=randomUUID();
    return this.context.run({...parent,spanId,parentSpanId:parent.spanId},async()=>{this.emit('span.started',{name});try{return await fn();}finally{this.emit('span.completed',{name});}});
  }
  async tool<T>(name:string,args:Record<string,unknown>,fn:()=>Promise<T>):Promise<T> {
    const callId=randomUUID();this.emit('tool.called',{tool:name,toolCallId:callId,arguments:args});
    try {const result=await fn();this.emit('tool.result',{tool:name,toolCallId:callId,success:true,result:typeof result==='object' && result!==null?result as Record<string,unknown>:{value:result}});return result;}
    catch(error){this.emit('tool.result',{tool:name,toolCallId:callId,success:false,text:error instanceof Error?error.message:'Tool failed.'});throw error;}
  }
  flush():Promise<void> {
    if(this.flushing)return this.flushing;
    this.flushing=this.deliver().catch(()=>{this.counters.deliveryFailures++;}).finally(()=>{this.flushing=undefined;});return this.flushing;
  }
  private async deliver(){
    while(this.buffer.length){
      const events:AgentEvent[]=[];let bytes=128;
      while(this.buffer.length && events.length<100){const size=Buffer.byteLength(JSON.stringify(this.buffer[0]))+1;if(events.length && bytes+size>900000)break;bytes+=size;events.push(this.buffer.shift()!);}
      const body=JSON.stringify({projectId:this.options.projectId,events});let sent=false;
      for(let attempt=0;attempt<3;attempt++){
        try{const response=await(this.options.transport??fetch)(`${this.options.endpoint.replace(/\/$/,'')}/v1/events`,{method:'POST',headers:{Authorization:`Bearer ${this.options.apiKey}`,'Content-Type':'application/json'},body,signal:AbortSignal.timeout(5000)});
          if(response.status===202){this.counters.delivered+=events.length;sent=true;break;}
          if(response.status<500 && response.status!==429)break;
        }catch{/* Agent execution is isolated from delivery failures. */}
        if(attempt<2){this.counters.retries++;await new Promise(resolve=>setTimeout(resolve,100*2**attempt));}
      }
      if(!sent){this.counters.dropped+=events.length;this.counters.deliveryFailures++;}
    }
  }
  async close(){clearInterval(this.timer);await this.flush();}
}
export async function submitEvidence(options:{endpoint:string;verifierKey:string;receipt:unknown}):Promise<boolean>{
  try{const body=redact(options.receipt);const timestamp=String(Math.floor(Date.now()/1000));const signature=createHmac('sha256',options.verifierKey).update(`${timestamp}.${canonical(body)}`).digest('hex');
    const result=await fetch(`${options.endpoint.replace(/\/$/,'')}/v1/evidence`,{method:'POST',headers:{Authorization:`Bearer ${options.verifierKey}`,'Content-Type':'application/json','x-receipt-timestamp':timestamp,'x-receipt-signature':signature},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});return result.ok;
  }catch{return false;}
}
export type { Outcome,AgentEvent };
